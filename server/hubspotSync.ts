import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { hubspotSyncJobs } from "../drizzle/schema";
import { requireDb, contacts, interactions, followUpTasks, auditEvents } from "./db";
import { hubspot, HubSpotRequestError, getHubSpotObject } from "./hubspot";

type Kind = "contact" | "note" | "task";
export async function syncHubSpotRecord(userId: number, kind: Kind, localId: number) {
  const db = await requireDb();
  const table = kind === "contact" ? contacts : kind === "note" ? interactions : followUpTasks;
  const row = await db.transaction(async tx => {
    const [record] = await tx.select().from(table).where(and(eq(table.id, localId), eq(table.userId, userId))).for("update");
    if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "Record not found" });
    const [job] = await tx.select().from(hubspotSyncJobs).where(and(eq(hubspotSyncJobs.userId, userId), eq(hubspotSyncJobs.kind, kind), eq(hubspotSyncJobs.localId, localId))).for("update");
    if (job && ["running", "uncertain"].includes(job.status)) throw new TRPCError({ code: "CONFLICT", message: "Previous sync is still running or uncertain. Reconcile it before retrying." });
    if (kind !== "contact") {
      const contactId = "contactId" in record ? record.contactId : 0;
      const [contact] = await tx.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
      if (!contact?.hubspotId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Sync the contact first" });
    }
    await tx.insert(hubspotSyncJobs).values({ userId, kind, localId, status: "running" }).onDuplicateKeyUpdate({ set: { status: "running", error: null } });
    return record;
  });
  try {
    let remote;
    if (kind === "contact") {
      const contact = row as typeof contacts.$inferSelect;
      const properties = { firstname: contact.firstName, lastname: contact.lastName, email: contact.email ?? "", phone: contact.phone ?? "", jobtitle: contact.role ?? "", company: contact.company ?? "" };
      remote = contact.hubspotId ? await hubspot.updateContact(contact.hubspotId, properties) : await hubspot.createContact(properties);
    } else {
      const contactId = "contactId" in row ? row.contactId : 0;
      const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
      if (kind === "note") { const note = row as typeof interactions.$inferSelect; remote = note.hubspotId ? await hubspot.updateNote(note.hubspotId, note.body) : await hubspot.createNote(contact.hubspotId!, note.body); }
      else { const task = row as typeof followUpTasks.$inferSelect; remote = task.hubspotId ? await hubspot.updateTask(task.hubspotId, task.title, task.dueAt, task.status === "completed") : await hubspot.createTask(contact.hubspotId!, task.title, task.dueAt); }
    }
    await db.transaction(async tx => {
      await tx.update(table).set({ hubspotId: remote.id, ...(kind !== "contact" ? { hubspotSyncStatus: "synced" } : {}) }).where(and(eq(table.id, localId), eq(table.userId, userId)));
      await tx.update(hubspotSyncJobs).set({ status: "succeeded", remoteId: remote.id, error: null }).where(and(eq(hubspotSyncJobs.userId, userId), eq(hubspotSyncJobs.kind, kind), eq(hubspotSyncJobs.localId, localId)));
      await tx.insert(auditEvents).values({ userId, event: "hubspot.synced", payload: JSON.stringify({ kind, localId, remoteId: remote.id }) });
    });
    return { success: true, hubspotId: remote.id };
  } catch (error) {
    // An interrupted POST may already have created the remote object. Never retry it blindly.
    const uncertain = !(error instanceof HubSpotRequestError) || error.status === null || error.status >= 500;
    await db.update(hubspotSyncJobs).set({ status: uncertain ? "uncertain" : "failed", error: uncertain ? "Remote result uncertain. Reconcile before retrying." : `Remote rejected request: HTTP ${(error as HubSpotRequestError).status}` }).where(and(eq(hubspotSyncJobs.userId, userId), eq(hubspotSyncJobs.kind, kind), eq(hubspotSyncJobs.localId, localId)));
    throw new TRPCError({ code: "BAD_GATEWAY", message: uncertain ? "Sync result is uncertain. Check HubSpot and reconcile this record before retrying." : "HubSpot rejected this sync. Check permissions and record details." });
  }
}

export async function reconcileHubSpotSync(userId: number, kind: Kind, localId: number, remoteId: string) {
  const objectKind = kind === "contact" ? "contacts" : kind === "note" ? "notes" : "tasks";
  const remote = await getHubSpotObject(objectKind, remoteId);
  const db = await requireDb();
  const table = kind === "contact" ? contacts : kind === "note" ? interactions : followUpTasks;
  await db.transaction(async tx => {
    const [record] = await tx.select().from(table).where(and(eq(table.id, localId), eq(table.userId, userId))).for("update");
    if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "Record not found" });
    if (kind !== "contact") {
      const [contact] = await tx.select().from(contacts).where(and(eq(contacts.id, "contactId" in record ? record.contactId : 0), eq(contacts.userId, userId)));
      if (!contact?.hubspotId || !remote.associations?.contacts?.results.some(item => item.id === contact.hubspotId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Remote record must be associated with this record’s linked contact" });
    }
    const [job] = await tx.select().from(hubspotSyncJobs).where(and(eq(hubspotSyncJobs.userId, userId), eq(hubspotSyncJobs.kind, kind), eq(hubspotSyncJobs.localId, localId))).for("update");
    if (!job || !["running", "uncertain"].includes(job.status)) throw new TRPCError({ code: "CONFLICT", message: "No uncertain sync exists for this record" });
    if (job.status === "running" && job.updatedAt.getTime() > Date.now() - 120000) throw new TRPCError({ code: "CONFLICT", message: "Allow the active request to finish before reconciling" });
    await tx.update(table).set({ hubspotId: remoteId, ...(kind !== "contact" ? { hubspotSyncStatus: "synced" } : {}) }).where(and(eq(table.userId, userId), eq(table.id, localId)));
    await tx.update(hubspotSyncJobs).set({ status: "succeeded", remoteId, error: null }).where(eq(hubspotSyncJobs.id, job.id));
    await tx.insert(auditEvents).values({ userId, event: "hubspot.reconciled", payload: JSON.stringify({ kind, localId, remoteId }) });
  });
  return { success: true };
}
