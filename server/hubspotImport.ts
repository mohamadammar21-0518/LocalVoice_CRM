import { invalidateContactCache } from "./_core/embeddings";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { requireDb, contacts, interactions, followUpTasks, users, auditEvents } from "./db";
import { listHubSpotPage, plainText, type RemoteObject } from "./hubspot";

export type ImportKind = "contacts" | "notes" | "tasks";
export type ImportItem = { remoteId: string; label: string; operation: "insert" | "update" | "link" | "skip"; reason: string | null; localId: number | null; contactId?: number };
export async function importHubSpotPage(userId: number, kind: ImportKind, after: string | undefined, apply: boolean, expectedFingerprint?: string) {
  const page = await listHubSpotPage(kind, after);
  const db = await requireDb();
  const result = await db.transaction(async tx => {
    // Serialize imports for this owner so two import tabs cannot duplicate a page.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    const items: ImportItem[] = [];
    const versions: string[] = [];
    for (const remote of page.results) {
      const p = remote.properties;
      let item: ImportItem = { remoteId: remote.id, label: kind === "contacts" ? [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || remote.id : plainText(kind === "notes" ? p.hs_note_body : p.hs_task_subject).slice(0, 140), operation: "insert", reason: null, localId: null };
      if (kind === "contacts") {
        let [existing] = await tx.select().from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.hubspotId, remote.id)));
        if (!existing && p.email) {
          const emailMatches = await tx.select().from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.email, p.email))).limit(2);
          if (emailMatches.length > 1 || (emailMatches[0]?.hubspotId && emailMatches[0].hubspotId !== remote.id)) item = { ...item, operation: "skip", reason: "Email matches conflicting local contacts" };
          else if (emailMatches.length === 1) { existing = emailMatches[0]; item.operation = "link"; }
        }
        if (existing) { item.localId = existing.id; if (item.operation === "insert") item.operation = "update"; versions.push(`${existing.id}:${existing.updatedAt.toISOString()}`); }
        if (!(p.firstname || p.lastname || p.email)) item = { ...item, operation: "skip", reason: "Contact has no name or email" };
      } else {
        const ids = remote.associations?.contacts?.results.map(contact => contact.id) ?? [];
        const linked = ids.length ? await tx.select().from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.hubspotId, ids))).limit(2) : [];
        if (linked.length !== 1) item = { ...item, operation: "skip", reason: linked.length ? "Record is associated with multiple imported contacts" : "Import the associated contact first" };
        else {
          item.contactId = linked[0].id;
          const table = kind === "notes" ? interactions : followUpTasks;
          const [existing] = await tx.select().from(table).where(and(eq(table.userId, userId), eq(table.hubspotId, remote.id)));
          if (existing) { item.localId = existing.id; item.operation = "update"; versions.push(JSON.stringify(existing)); }
        }
        const date = new Date(p.hs_timestamp ?? "");
        if (!item.label || !Number.isFinite(date.getTime())) item = { ...item, operation: "skip", reason: "Record has missing text or timestamp" };
      }
      items.push(item);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ userId, kind, records: page.results, items, versions })).digest("hex");
    if (apply && fingerprint !== expectedFingerprint) throw new TRPCError({ code: "CONFLICT", message: "HubSpot or local records changed. Preview this page again before importing." });
    if (apply) {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item.operation === "skip") continue;
        const remote: RemoteObject = page.results[index];
        const p = remote.properties;
        if (kind === "contacts") {
          if (item.operation === "link") {
            await tx.update(contacts).set({ hubspotId: remote.id }).where(and(eq(contacts.id, item.localId!), eq(contacts.userId, userId)));
            continue;
          }
          const values = { userId, hubspotId: remote.id, firstName: (p.firstname || p.email || "Unnamed").slice(0, 100), lastName: (p.lastname || "").slice(0, 100), company: p.company?.slice(0, 160) ?? null, role: p.jobtitle?.slice(0, 160) ?? null, email: p.email?.slice(0, 320) ?? null, phone: p.phone?.slice(0, 60) ?? null };
          if (item.localId) await tx.update(contacts).set(values).where(and(eq(contacts.id, item.localId), eq(contacts.userId, userId)));
          else await tx.insert(contacts).values(values);
        } else if (kind === "notes") {
          const values = { userId, contactId: item.contactId!, hubspotId: remote.id, hubspotSyncStatus: "synced" as const, kind: "note" as const, body: plainText(p.hs_note_body).slice(0, 10000), occurredAt: new Date(p.hs_timestamp!) };
          if (item.localId) await tx.update(interactions).set(values).where(and(eq(interactions.id, item.localId), eq(interactions.userId, userId)));
          else await tx.insert(interactions).values(values);
        } else {
          const completed = p.hs_task_status === "COMPLETED";
          const values = { userId, contactId: item.contactId!, hubspotId: remote.id, hubspotSyncStatus: "synced" as const, title: plainText(p.hs_task_subject).slice(0, 240), dueAt: new Date(p.hs_timestamp!), status: completed ? "completed" as const : "open" as const, completedAt: completed ? new Date() : null };
          if (item.localId) await tx.update(followUpTasks).set(values).where(and(eq(followUpTasks.id, item.localId), eq(followUpTasks.userId, userId)));
          else await tx.insert(followUpTasks).values(values);
        }
      }
      await tx.insert(auditEvents).values({ userId, event: "hubspot.imported", payload: JSON.stringify({ kind, fingerprint, items }) });
    }
    return { kind, items, after: page.after, fingerprint, applied: apply };
  });
  if (apply && kind === "contacts") invalidateContactCache(userId);
  return result;
}
