import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { proposalSchema, type Proposal, type ReviewedProposal } from "../shared/voice";
import { requireDb, contacts, interactions, followUpTasks, voiceSessions, auditEvents, searchContacts } from "./db";
import { dueDateInZone, validDateSafe } from "./_core/dates";

export async function resolveProposalContacts(userId: number, proposal: Proposal): Promise<ReviewedProposal> {
  const actions = await Promise.all(proposal.actions.map(async action => {
    const matches = action.contactName?.trim() ? await searchContacts(userId, action.contactName.trim(), 20) : [];
    const exact = matches.filter(contact => `${contact.firstName} ${contact.lastName}`.toLowerCase() === action.contactName?.trim().toLowerCase());
    const selected = exact.length === 1 ? exact[0] : exact.length === 0 && matches.length === 1 ? matches[0] : null;
    return { ...action, contactId: selected?.id ?? null, candidates: matches.map(contact => ({ id: contact.id, name: `${contact.firstName} ${contact.lastName}`, company: contact.company, email: contact.email })) };
  }));
  return { ...proposal, actions };
}

export async function storeProposal(userId: number, sessionId: number | null | undefined, proposal: ReviewedProposal, signal?: AbortSignal, transcript = "") {
  const db = await requireDb();
  return db.transaction(async tx => {
    signal?.throwIfAborted();
    let id = sessionId;
    if (!id) {
      const inserted = await tx.insert(voiceSessions).values({ userId, status: "transcribed" });
      id = inserted[0].insertId;
    }
    const [session] = await tx.select().from(voiceSessions).where(and(eq(voiceSessions.id, id), eq(voiceSessions.userId, userId))).for("update");
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Voice session not found" });
    if (!["transcribed", "proposed"].includes(session.status)) throw new TRPCError({ code: "CONFLICT", message: "Start a new request for a completed or discarded session" });
    const updated = { ...proposal, version: session.proposalVersion + 1 };
    await tx.update(voiceSessions).set({ transcript, status: "proposed", proposalVersion: updated.version, proposalType: updated.actions[0].type, proposalJson: JSON.stringify(updated) }).where(and(eq(voiceSessions.id, id), eq(voiceSessions.userId, userId)));
    signal?.throwIfAborted();
    return { sessionId: id, proposal: updated };
  });
}

export type ConfirmationResult = {
  success: true; replayed: boolean; receipt: string;
  actions: { type: string; contact: { id: number; firstName: string; lastName: string }; recordId: number | null }[];
};
export function proposalFingerprint(proposal: Proposal) {
  return createHash("sha256").update(JSON.stringify({ version: proposal.version, timezone: proposal.timezone, actions: proposal.actions.map(action => ({ type: action.type, contactId: action.contactId ?? null, note: action.note?.trim() ?? null, taskTitle: action.taskTitle?.trim() ?? null, dueDate: action.dueDate ?? null })) })).digest("hex");
}
export async function confirmVoiceProposal(userId: number, sessionId: number, rawProposal: Proposal): Promise<ConfirmationResult> {
  const proposal = proposalSchema.parse(rawProposal);
  const fingerprint = proposalFingerprint(proposal);
  const db = await requireDb();
  return db.transaction(async tx => {
    // The row lock serializes concurrent confirms AND proposal regeneration.
    const [session] = await tx.select().from(voiceSessions).where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.userId, userId))).for("update");
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Voice session not found" });
    if (session.status === "confirmed" && session.confirmedResultJson) {
      const saved = JSON.parse(session.confirmedResultJson) as { fingerprint: string; result: ConfirmationResult };
      if (saved.fingerprint !== fingerprint) throw new TRPCError({ code: "CONFLICT", message: "This session already saved a different batch. Start a new request." });
      return { ...saved.result, replayed: true };
    }
    if (session.status !== "proposed" || session.proposalVersion !== proposal.version) throw new TRPCError({ code: "CONFLICT", message: "This proposal changed or is no longer pending. Review the latest proposal." });
    const persisted = proposalSchema.parse(JSON.parse(session.proposalJson!));
    if (persisted.timezone !== proposal.timezone) throw new TRPCError({ code: "BAD_REQUEST", message: "Regenerate the proposal after changing timezone" });
    const resolved = [];
    for (const action of proposal.actions) {
      if (action.type === "unsupported") throw new TRPCError({ code: "BAD_REQUEST", message: action.reason ?? "Unsupported action" });
      if (!action.contactId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a specific contact for every action" });
      const [contact] = await tx.select().from(contacts).where(and(eq(contacts.id, action.contactId), eq(contacts.userId, userId))).for("update");
      if (!contact) throw new TRPCError({ code: "NOT_FOUND", message: "The selected contact no longer exists" });
      if (action.type === "add_note" && !action.note?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter note text" });
      if (action.type === "create_follow_up" && (!action.taskTitle?.trim() || !action.dueDate || !validDateSafe(action.dueDate))) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a task title and valid calendar date" });
      resolved.push({ action, contact });
    }
    const actions: ConfirmationResult["actions"] = [];
    for (const { action, contact } of resolved) {
      let recordId: number | null = null;
      if (action.type === "add_note") recordId = (await tx.insert(interactions).values({ userId, contactId: contact.id, kind: "note", body: action.note!.trim() }))[0].insertId;
      if (action.type === "create_follow_up") recordId = (await tx.insert(followUpTasks).values({ userId, contactId: contact.id, title: action.taskTitle!.trim(), dueAt: dueDateInZone(action.dueDate!, proposal.timezone) }))[0].insertId;
      actions.push({ type: action.type, contact: { id: contact.id, firstName: contact.firstName, lastName: contact.lastName }, recordId });
    }
    const receipt = resolved.map(({ action, contact }) => {
      const name = `${contact.firstName} ${contact.lastName}`;
      if (action.type === "lookup_contact") return `Found ${name}.`;
      if (action.type === "add_note") return `Saved the note to ${name}.`;
      return `Created the follow-up for ${name} on ${action.dueDate}, at 9 AM in ${proposal.timezone}.`;
    }).join(" ");
    const result: ConfirmationResult = { success: true, replayed: false, actions, receipt };
    const approved = { ...proposal, actions: resolved.map(({ action, contact }) => ({ ...action, contactName: `${contact.firstName} ${contact.lastName}` })) };
    await tx.update(voiceSessions).set({ status: "confirmed", proposalJson: JSON.stringify(approved), confirmedResultJson: JSON.stringify({ fingerprint, result }) }).where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.userId, userId)));
    await tx.insert(auditEvents).values({ userId, sessionId, event: "voice.confirmed", payload: JSON.stringify({ proposal: approved, result }) });
    return result;
  });
}

export async function rejectVoiceProposal(userId: number, sessionId: number) {
  const db = await requireDb();
  return db.transaction(async tx => {
    const [session] = await tx.select().from(voiceSessions).where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.userId, userId))).for("update");
    if (!session) throw new TRPCError({ code: "NOT_FOUND" });
    if (session.status === "confirmed") throw new TRPCError({ code: "CONFLICT", message: "This batch was already saved" });
    await tx.update(voiceSessions).set({ status: "rejected" }).where(and(eq(voiceSessions.id, sessionId), eq(voiceSessions.userId, userId)));
    await tx.insert(auditEvents).values({ userId, sessionId, event: "voice.rejected", payload: "{}" });
    return { success: true };
  });
}
