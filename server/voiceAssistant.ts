import { z } from "zod";
import { commonCrmIntent } from "./intentRules";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { proposalSchema, type CrmSource, type ContactChoice, type VoiceTurn, type VoiceSource } from "../shared/voice";
import { invokeLLM } from "./_core/llm";
import { civilDate, resolveDateExpression, validDateSafe } from "./_core/dates";
import { getContact, searchContacts, getInteractions, getTasks, getDashboard, requireDb, voiceSessions } from "./db";
import { getAssociatedRecords, getHubSpotObject, plainText, isHubSpotConfigured } from "./hubspot";
import { resolveProposalContacts, storeProposal } from "./voiceActions";

const modelAction = z.object({ type: z.enum(["lookup_contact", "add_note", "create_follow_up", "unsupported"]), contactName: z.string().max(240).nullable(), note: z.string().max(10000).nullable(), taskTitle: z.string().max(240).nullable(), dueDate: z.string().max(80).nullable(), dateExpression: z.string().max(100).nullable(), reason: z.string().max(500).nullable() });
export const intentSchema = z.object({
  kind: z.enum(["contacts", "history", "tasks", "dashboard", "propose", "unsupported"]),
  contactQuery: z.string().max(240).nullable(),
  taskFilter: z.enum(["all", "open", "overdue"]),
  limit: z.number().int().min(1).max(10),
  actions: z.array(modelAction).max(5),
});
type Intent = z.infer<typeof intentSchema>;
export type TurnUser = { id: number; role: "user" | "admin" };
type TurnInput = { prompt: string; sessionId?: number | null; source: CrmSource; timezone: string; contactId?: number | null; forceProposal?: boolean; responseLanguage?: "en" | "ms" };
type TurnOptions = { signal?: AbortSignal; onFirstToken?: (ms: number) => void; now?: Date };
const nameOf = (contact: { firstName: string; lastName: string }) => `${contact.firstName} ${contact.lastName}`;
const dateLabel = (value: Date | string, timezone: string, ms = false) => new Date(value).toLocaleDateString(ms ? "ms-MY" : "en-GB", { timeZone: timezone, day: "numeric", month: "short", year: "numeric" });
const choiceOf = (contact: { id: number; firstName: string; lastName: string; company: string | null; email: string | null }): ContactChoice => ({ id: contact.id, name: nameOf(contact), company: contact.company, email: contact.email });

export async function prepareVoiceTurn(user: TurnUser, input: TurnInput, options: TurnOptions = {}): Promise<VoiceTurn & { choices: ContactChoice[] }> {
  const { signal } = options;
  const ms = input.responseLanguage === "ms";
  if (input.source !== "local" && (user.role !== "admin" || !isHubSpotConfigured())) throw new TRPCError({ code: "FORBIDDEN", message: "HubSpot access requires an administrator and a configured token" });
  if (input.sessionId) {
    const db = await requireDb();
    const [session] = await db.select({ id: voiceSessions.id }).from(voiceSessions).where(and(eq(voiceSessions.id, input.sessionId), eq(voiceSessions.userId, user.id)));
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Voice session not found" });
  }
  let contextContact = input.contactId ? await getContact(user.id, input.contactId) : null;
  if (input.contactId && !contextContact) throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
  const { intent, response } = await planVoiceRequest(input, contextContact, options);
  if (contextContact && intent.contactQuery && !nameOf(contextContact).toLowerCase().includes(intent.contactQuery.toLowerCase())) contextContact = null;
  signal?.throwIfAborted();
  const retrievalStart = performance.now();
  const result: VoiceTurn & { choices: ContactChoice[] } = { text: "", sources: [], sessionId: input.sessionId ?? null, proposal: null, warnings: [], choices: [], llmMs: response.timing.totalMs, retrievalMs: 0, loadMs: response.timing.loadMs, inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 };
  if (intent.kind === "propose" || input.forceProposal) {
    if (intent.kind !== "propose" || !intent.actions.length) {
      result.text = "I can propose notes and follow-ups for existing contacts. Please include the contact and the details to save.";
    } else {
      const proposal = proposalSchema.parse({ actions: intent.actions.map(action => {
        const relative = resolveDateExpression(action.dateExpression, input.timezone, options.now);
        const dueDate = action.dateExpression ? relative : action.dueDate;
        return { ...action, dueDate: dueDate && validDateSafe(dueDate) ? dueDate : null };
      }), timezone: input.timezone });
      const resolved = await resolveProposalContacts(user.id, proposal);
      const saved = await storeProposal(user.id, input.sessionId, resolved, signal, input.prompt);
      result.sessionId = saved.sessionId; result.proposal = saved.proposal;
      result.text = ms ? `${saved.proposal.actions.length} tindakan disediakan untuk semakan. Semak kenalan, butiran dan tarikh, kemudian sahkan untuk menyimpan.` : `Prepared ${saved.proposal.actions.length} action${saved.proposal.actions.length === 1 ? "" : "s"} for review. Please check the contacts, details and dates, then confirm to save.`;
      if (saved.proposal.actions.some(action => action.type !== "unsupported" && !action.contactId)) result.warnings.push("Choose a specific contact for each unresolved action.");
    }
  } else if (intent.kind === "unsupported") {
    result.text = ms ? "Saya boleh membaca kenalan, nota dan susulan, atau menyediakan nota dan susulan untuk kelulusan anda. Sila tanya soalan CRM atau nyatakan tindakan yang disokong." : "I can read contacts, notes, and follow-ups, or prepare notes and follow-ups for your approval. Please ask a CRM question or specify a supported action.";
  } else if (intent.kind === "dashboard") {
    if (input.source === "hubspot") { result.text = "A complete HubSpot dashboard requires importing its records first. Ask about a specific imported contact for a live HubSpot answer."; }
    else {
      const dashboard = await getDashboard(user.id);
      result.text = ms ? `CRM tempatan anda mempunyai ${dashboard.contactCount} kenalan, ${dashboard.openTaskCount} susulan terbuka dan ${dashboard.overdueCount} susulan tertunggak.` : `Your local CRM has ${dashboard.contactCount} contacts, ${dashboard.openTaskCount} open follow-ups, and ${dashboard.overdueCount} overdue follow-ups.`;
      result.sources.push({ kind: "dashboard", id: String(user.id), label: "Local CRM overview", provider: "local" });
      if (input.source === "both") result.warnings.push("Dashboard counts cover local records, including records you imported; they are not a full HubSpot account total.");
    }
  } else {
    const matches = contextContact ? [contextContact] : intent.contactQuery ? await searchContacts(user.id, intent.contactQuery, 20) : [];
    if (intent.kind === "contacts") {
      const found = matches.length ? matches.slice(0, intent.limit) : intent.contactQuery ? [] : await searchContacts(user.id, "", intent.limit);
      if (!found.length) result.text = ms ? "Tiada kenalan sepadan ditemui dalam CRM tempatan. Import kenalan HubSpot atau cuba nama lain." : "No matching contacts were found in your local CRM. Import your HubSpot contacts or try a different name.";
      else {
        // Fetch all HubSpot contacts concurrently instead of serially (was N sequential calls)
        const remoteResults = await Promise.all(
          found.map(async contact => {
            if (input.source !== "local" && contact.hubspotId) {
              try {
                signal?.throwIfAborted();
                return { contact, remote: await getHubSpotObject("contacts", contact.hubspotId, signal) };
              } catch {
                if (signal?.aborted) signal.throwIfAborted();
                return { contact, remote: null, failed: true };
              }
            }
            return { contact, remote: null };
          })
        );

        const lines: string[] = [];
        for (const { contact, remote, failed } of remoteResults) {
          if (failed) result.warnings.push(`Could not read the live HubSpot contact for ${nameOf(contact)}.`);
          if (remote) {
            lines.push(`${ms ? "Kenalan HubSpot" : "HubSpot contact"}: ${[remote.properties.firstname, remote.properties.lastname].filter(Boolean).join(" ") || nameOf(contact)}${remote.properties.company ? `${ms ? " di " : " at "}${remote.properties.company}` : ""}. ${remote.properties.email ? `${ms ? "E-mel" : "Email"}: ${remote.properties.email}.` : ""} ${remote.properties.phone ? `${ms ? "Telefon" : "Phone"}: ${remote.properties.phone}.` : ""}`);
            result.sources.push({ kind: "contact", id: remote.id, label: nameOf(contact), provider: "hubspot" });
          } else if (input.source === "hubspot" && !failed) {
            result.warnings.push(`${nameOf(contact)} is not linked to a HubSpot contact.`);
          }
          if (input.source !== "hubspot") {
            lines.push(`${nameOf(contact)}${contact.role ? `, ${contact.role}` : ""}${contact.company ? `${ms ? " di " : " at "}${contact.company}` : ""}. ${contact.email ? `${ms ? "E-mel" : "Email"}: ${contact.email}.` : ""} ${contact.phone ? `${ms ? "Telefon" : "Phone"}: ${contact.phone}.` : ""}`);
            result.sources.push({ kind: "contact", id: String(contact.id), label: nameOf(contact), provider: "local" });
          }
        }
        result.text = lines.join(" ").trim() || "No live HubSpot contact could be retrieved.";
        result.choices = found.map(choiceOf);
      }
    } else {
      // History needs one specific person; global local follow-ups are supported.
      const exact = matches.filter(contact => nameOf(contact).toLowerCase() === intent.contactQuery?.toLowerCase());
      contextContact = contextContact ?? (exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null);
      if (matches.length > 1 && !contextContact) {
        result.text = ms ? `${matches.length} kenalan sepadan ditemui. Pilih orang yang betul, kemudian tanya semula.` : `I found ${matches.length} matching contacts. Choose the correct person, then ask again.`;
        result.choices = matches.map(choiceOf);
      } else if (!contextContact && (intent.contactQuery || intent.kind === "history" || input.source === "hubspot")) result.text = ms ? "Pilih kenalan yang telah diimport atau nyatakan nama kenalan. Saya tidak dapat mengenal pasti orang yang tepat." : "Choose an imported contact or include a specific contact name. I could not identify a unique person.";
      else result.text = await renderRecords(user.id, contextContact, intent, input.source, input.timezone, result.sources, result.warnings, signal, ms);
    }
  }
  result.retrievalMs = Math.round(performance.now() - retrievalStart);
  return result;
}

async function renderRecords(userId: number, contact: Awaited<ReturnType<typeof getContact>> | null, intent: Intent, source: CrmSource, timezone: string, sources: VoiceSource[], warnings: string[], signal?: AbortSignal, ms = false) {
  const kind = intent.kind === "history" ? "notes" : "tasks";
  const rows: { id: string; text: string; date: Date; provider: "local" | "hubspot"; remoteId?: string }[] = [];
  if (source !== "hubspot") {
    if (kind === "notes") {
      for (const record of await getInteractions(userId, contact!.id, intent.limit)) rows.push({ id: String(record.id), text: `${record.kind}: ${record.body}`, date: record.occurredAt, provider: "local", remoteId: record.hubspotId ?? undefined });
    } else {
      for (const { task, contact: person } of await getTasks(userId, intent.taskFilter, contact?.id, intent.limit)) rows.push({ id: String(task.id), text: `${task.title}${!contact && person ? `${ms ? " untuk " : " for "}${nameOf(person)}` : ""}, ${ms ? task.status === "completed" ? "selesai" : "terbuka" : task.status}`, date: task.dueAt, provider: "local", remoteId: task.hubspotId ?? undefined });
    }
  }
  if (source !== "local" && contact?.hubspotId) {
    try {
      const remote = await getAssociatedRecords(contact.hubspotId, kind, signal);
      if (remote.truncated) warnings.push("HubSpot returned only the first 100 associations; this answer may omit older records.");
      const remoteIds = new Set(remote.results.map(record => record.id));
      for (let index = rows.length - 1; index >= 0; index--) if (rows[index].remoteId && remoteIds.has(rows[index].remoteId!)) rows.splice(index, 1);
      for (const record of remote.results) {
        const date = new Date(record.properties.hs_timestamp ?? "");
        if (!Number.isFinite(date.getTime())) continue;
        const completed = record.properties.hs_task_status === "COMPLETED";
        if (kind === "tasks" && ((intent.taskFilter !== "all" && completed) || (intent.taskFilter === "overdue" && date >= new Date()))) continue;
        rows.push({ id: record.id, text: kind === "notes" ? `note: ${plainText(record.properties.hs_note_body)}` : `${plainText(record.properties.hs_task_subject)}, ${ms ? completed ? "selesai" : "terbuka" : completed ? "completed" : "open"}`, date, provider: "hubspot" });
      }
    } catch { if (signal?.aborted) signal.throwIfAborted(); warnings.push("Live HubSpot records could not be read; local records may be out of date."); }
  } else if (source !== "local") warnings.push(contact ? "This contact is not linked to HubSpot." : "Global follow-ups use local records. Choose an imported contact for live HubSpot follow-ups.");
  rows.sort((a, b) => kind === "notes" ? b.date.getTime() - a.date.getTime() : a.date.getTime() - b.date.getTime());
  const selected = rows.slice(0, intent.limit);
  if (!selected.length && ms) return `Tiada ${kind === "notes" ? "interaksi" : "susulan"}${contact ? ` untuk ${nameOf(contact)}` : ""} ditemui dalam rekod yang boleh dibaca.`;
  if (!selected.length) return `No ${kind === "notes" ? "interactions" : `${intent.taskFilter === "all" ? "" : intent.taskFilter + " "}follow-ups`} ${contact ? `for ${nameOf(contact)} ` : ""}were found in the records I could read.`;
  const lines = selected.map(record => {
    sources.push({ kind: kind === "notes" ? "interaction" : "task", id: record.id, label: `${record.provider === "hubspot" ? "HubSpot" : "Local"} · ${dateLabel(record.date, timezone, ms)}`, provider: record.provider });
    return `${dateLabel(record.date, timezone)}: ${record.text.slice(0, 700)}${record.text.length > 700 ? "…" : ""}.`;
  });
  return `${contact ? `${ms ? "Untuk" : "For"} ${nameOf(contact)}: ` : ""}${lines.join(" ")}`;
}

export async function planVoiceRequest(input: TurnInput, contextContact: { firstName: string; lastName: string } | null = null, options: TurnOptions = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const shortcut = commonCrmIntent(input.prompt, contextContact ? nameOf(contextContact) : undefined);
  if (shortcut) {
    const intent = intentSchema.parse(shortcut);
    return { intent, response: { timing: { totalMs: 0, queueMs: 0, loadMs: 0, firstTokenMs: null }, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } };
  }
  const system = `Convert the user's CRM request to JSON with these keys: kind, contactQuery, taskFilter, limit, actions. kind must be contacts (find a person), history (read notes or conversations), tasks (read reminders/follow-ups), dashboard (counts), propose (prepare writes), or unsupported. taskFilter must be all, open or overdue; use all when no task filter was requested. actions is empty for reads and unsupported. For propose each action has type (lookup_contact, add_note, create_follow_up), contactName, note, taskTitle, dueDate, dateExpression, reason; set unused fields to null. You can only search contacts, read interaction history, list follow-up tasks, report a dashboard, or propose adding notes and follow-ups. Never invent CRM facts or claim a change was saved. For conversation, email sending, deletion, contact creation and other unsupported requests choose unsupported. Requests to add or save notes and reminders choose propose. Every distinct requested operation needs its own action, including an explicit contact lookup in a batch. A follow-up or reminder is create_follow_up, never add_note. Pure reads must have actions: []. 'Show/list overdue follow-ups' and Malay 'tunjukkan tugasan susulan yang lewat' are tasks with taskFilter overdue; counts/'how many'/'berapa banyak' are dashboard. Out-of-domain questions (weather, jokes, advice) are unsupported. Sending an email is unsupported; creating a reminder to send an email is supported. Do not turn unsupported requests into notes. Default read limit is 5; latest/last is 1. Task title is only the thing to do; note is only what the user asks to record. Set irrelevant fields to null. English and Malay commands are supported. Preserve Malay date expressions such as esok, lusa, Jumaat depan exactly. For 'what did I last discuss' choose history with limit 1. 'contactQuery' is only the person's name, company or role without command words; null for all tasks/dashboard. For duplicate names the application will ask the user to choose. Current date: ${civilDate(options.now ?? new Date(), input.timezone)}. Timezone: ${input.timezone}. Follow-up date is YYYY-MM-DD; do not invent a missing date. Copy spoken relative dates exactly into dateExpression (e.g. 'tomorrow', 'next Friday'); otherwise null. No CRM writes are possible here. ${contextContact ? `Selected contact: ${nameOf(contextContact)}. Use this name for pronouns referring to the selected contact.` : "Do not guess a person from a pronoun without a name."} ${input.forceProposal ? "Only propose or unsupported is allowed for this request." : ""}`;
  const examples: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: "Show open reminders for Alex Tan" },
    { role: "assistant", content: JSON.stringify({ kind: "tasks", contactQuery: "Alex Tan", taskFilter: "open", limit: 5, actions: [] }) },
    { role: "user", content: "What was my last conversation with Sara Lim?" },
    { role: "assistant", content: JSON.stringify({ kind: "history", contactQuery: "Sara Lim", taskFilter: "all", limit: 1, actions: [] }) },
    { role: "user", content: "Find Sara Lim, save a note that delivery was approved, and remind me tomorrow to call Sara" },
    { role: "assistant", content: JSON.stringify({ kind: "propose", contactQuery: "Sara Lim", taskFilter: "all", limit: 5, actions: [
      { type: "lookup_contact", contactName: "Sara Lim", note: null, taskTitle: null, dueDate: null, dateExpression: null, reason: null },
      { type: "add_note", contactName: "Sara Lim", note: "Delivery was approved", taskTitle: null, dueDate: null, dateExpression: null, reason: null },
      { type: "create_follow_up", contactName: "Sara Lim", note: null, taskTitle: "Call Sara", dueDate: null, dateExpression: "tomorrow", reason: null }
    ] }) }
  ];
  const response = await invokeLLM({ messages: [{ role: "system", content: system }, ...examples, { role: "user", content: input.prompt }], outputSchema: { name: "crm_intent", schema: z.toJSONSchema(intentSchema) }, signal, onFirstToken: options.onFirstToken });
  let intent: Intent;
  try { intent = intentSchema.parse(JSON.parse(response.choices[0].message.content)); }
  catch { throw new TRPCError({ code: "BAD_GATEWAY", message: "The local model returned an invalid CRM request. Please rephrase it." }); }
  if ((intent.kind === "propose" && !intent.actions.length) || (intent.kind !== "propose" && intent.actions.length)) throw new TRPCError({ code: "BAD_GATEWAY", message: "The local model returned inconsistent actions. Please rephrase the request." });
  return { intent, response };
}
