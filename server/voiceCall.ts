import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { sourceSchema, timezoneSchema, type ContactChoice } from "../shared/voice";
import { callControl, type CallReply } from "../shared/voiceCall";
import { prepareVoiceTurn } from "./voiceAssistant";
import { confirmVoiceProposal, rejectVoiceProposal } from "./voiceActions";
import type { TrpcContext } from "./_core/context";
import { prepareHubspotCall, type HubspotCallContext } from "./voiceCallHubspot";
import { prepareSalesforceCall, type SalesforceCallContext } from "./voiceCallSalesforce";
import { withHubspot, hubspotIdentity } from "./hubspotAuth";
import { answerGeneralCallQuestion, isGeneralCallQuestion } from "./voiceCallGeneral";

type Pending = { id: string; expires: number; text: string; delete?: boolean; execute: () => Promise<string>; reject: () => Promise<unknown> };
type Call = {
  owner: number; version: number; expires: number; busy: boolean;
  source: "local" | "hubspot" | "both" | "salesforce"; timezone: string; language: "en" | "ms";
  contact: ContactChoice | null; choices: ContactChoice[]; previous: string;
  pending?: Pending; lastReply: CallReply; cache: Map<string, CallReply>; controller: AbortController;
  hubspot: HubspotCallContext;
  salesforce: SalesforceCallContext; connection?: string;
};
const ttl = 30 * 60_000;

/** In-memory calls carry context and exact pending proposals, never credentials. */
export class VoiceCalls {
  private calls = new Map<string, Call>();
  constructor(private deps = { prepare: prepareVoiceTurn, confirm: confirmVoiceProposal, reject: rejectVoiceProposal }) {}
  start(ctx: TrpcContext, options: Pick<Call, "source" | "timezone" | "language">) {
    if (options.source === "both" && ctx.user!.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Shared imported HubSpot calls require an administrator." });
    for (const [id, call] of this.calls) if (call.expires < Date.now()) { call.controller.abort(); this.calls.delete(id); }
    if (this.calls.size >= 64 || [...this.calls.values()].filter(c => c.owner === ctx.user!.id).length >= 3)
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "End an existing call before starting another." });
    const id = randomUUID();
    const reply: CallReply = { text: options.language === "ms"
      ? "Helo. Saya sedia membantu dengan CRM anda. Apakah yang anda perlukan?"
      : "Hello. I'm ready to help with your CRM. What would you like to do?" };
    this.calls.set(id, { ...options, owner: ctx.user!.id, version: ctx.user!.sessionVersion, expires: Date.now() + ttl,
      busy: false, contact: null, choices: [], previous: "", lastReply: reply, cache: new Map(), controller: new AbortController(), hubspot: {}, salesforce: {} });
    return { id, ...reply };
  }
  private get(ctx: TrpcContext, id: string) {
    const call = this.calls.get(id);
    if (!call || call.owner !== ctx.user!.id || call.version !== ctx.user!.sessionVersion || call.expires < Date.now())
      throw new TRPCError({ code: "NOT_FOUND", message: "This call ended. Start a new call." });
    return call;
  }
  async end(ctx: TrpcContext, id: string) {
    const call = this.get(ctx, id);
    call.controller.abort(); this.calls.delete(id);
    if (call.pending && !call.busy) await call.pending.reject().catch(() => {});
    return { ended: true };
  }
  async turn(ctx: TrpcContext, input: { callId: string; requestId: string; text: string; reviewedId?: string }) {
    const call = this.get(ctx, input.callId);
    const cached = call.cache.get(input.requestId);
    if (cached) return cached;
    if (call.busy) throw new TRPCError({ code: "CONFLICT", message: "The previous request is still finishing." });
    call.busy = true; call.expires = Date.now() + ttl;
    try {
      const reply = await (call.source === "hubspot" ? withHubspot(ctx.user!, async () => {
        if (call.connection && call.connection !== hubspotIdentity()) throw new TRPCError({ code: "CONFLICT", message: "HubSpot account changed. End this call and start a new one." });
        call.connection = hubspotIdentity();
        return this.respond(ctx, call, input);
      }) : this.respond(ctx, call, input));
      call.lastReply = reply; call.cache.set(input.requestId, reply);
      if (call.cache.size > 20) call.cache.delete(call.cache.keys().next().value!);
      return reply;
    } finally { call.busy = false; }
  }
  private async respond(ctx: TrpcContext, call: Call, input: { text: string; reviewedId?: string }): Promise<CallReply> {
    const control = callControl(input.text);
    if (call.pending && call.pending.expires < Date.now()) { await call.pending.reject(); call.pending = undefined; }
    if (control === "end") return { text: "Goodbye. Your call has ended.", end: true };
    if (control === "repeat") return call.pending ? { text: call.pending.text, reviewId: call.pending.id } : call.lastReply;
    if (control === "cancel") {
      if (call.pending) await call.pending.reject();
      call.pending = undefined; call.previous = "";
      return { text: "Cancelled. What would you like to do next?" };
    }
    if (control === "confirm" || control === "confirmDelete") {
      const pending = call.pending;
      if (!pending) return { text: "There is no change waiting for approval. What would you like to do?" };
      if (input.reviewedId !== pending.id || (pending.delete ? control !== "confirmDelete" : control !== "confirm")) return { text: pending.text, reviewId: pending.id };
      // Retry-safe: the closure is bound to the exact server-owned proposal.
      const text = await pending.execute();
      call.pending = undefined; call.previous = "";
      return { text: `${text} What else can I help with?`, saved: true };
    }
    if (/^(yes|yeah|yep|okay|ok|sure|ya|no|nope)[.!?\s]*$/i.test(input.text))
      return call.pending ? { text: call.pending.text, reviewId: call.pending.id } : { text: "What would you like me to find or change?" };
    if (/^(hi|hello|hey|thank you|thanks)[.!?\s]*$/i.test(input.text)) return { text: "I'm here. You can ask about contacts, notes or follow-ups." };

    let prompt = input.text;
    const selected = call.choices.find(c => c.name.toLowerCase() === input.text.trim().toLowerCase());
    const ordinal = input.text.trim().toLowerCase().match(/^(?:the |number |option )?(first|second|third|one|two|three|1|2|3)(?: one)?[.!?]?$/);
    const positions: Record<string, number> = { first: 0, one: 0, "1": 0, second: 1, two: 1, "2": 1, third: 2, three: 2, "3": 2 };
    const choice = selected ?? (ordinal ? call.choices[positions[ordinal[1]]] : undefined);
    if (choice) { call.contact = choice; call.choices = []; prompt = `${call.previous}\nThe user selected the contact ${choice.name}.`; }
    else if (call.previous && /^(actually|instead|change|make it|no[, ]|tomorrow|next |esok|tukar)/i.test(prompt))
      prompt = `Previous request: ${call.previous}\nUser correction (supersedes previous details): ${prompt}`;
    if (call.pending) { await call.pending.reject(); call.pending = undefined; }
    if (isGeneralCallQuestion(prompt)) {
      const text = await answerGeneralCallQuestion(prompt, call.language, call.controller.signal);
      call.controller.signal.throwIfAborted();
      call.previous = ""; call.choices = [];
      return { text };
    }
    if (call.source === "hubspot" || call.source === "salesforce") {
      const result = call.source === "hubspot" ? await prepareHubspotCall(ctx, prompt, call.hubspot, call.controller.signal)
        : await prepareSalesforceCall(ctx, prompt, call.salesforce, call.controller.signal);
      call.controller.signal.throwIfAborted(); call.previous = prompt.slice(-3000);
      if (!result.change) return { text: result.text };
      const text = `${result.text} After I finish, say ${result.change.delete ? "confirm delete" : "confirm change"} to approve, cancel change to discard, or tell me what to correct.`;
      call.pending = { ...result.change, id: randomUUID(), expires: Date.now() + 120_000, text };
      return { text, reviewId: call.pending.id };
    }
    const turn = await this.deps.prepare(ctx.user!, { prompt, source: call.source, timezone: call.timezone,
      responseLanguage: call.language, contactId: call.contact?.id }, { signal: call.controller.signal });
    call.controller.signal.throwIfAborted();
    call.previous = prompt.slice(-3000); call.choices = turn.choices;
    if (turn.choices.length === 1) call.contact = turn.choices[0];
    if (!turn.proposal || !turn.sessionId) return { text: turn.text + (turn.choices.length > 1 ? " Say the full name, or say number one, two or three." : "") };
    const proposal = turn.proposal;
    const supported = proposal.actions.every(a => a.type !== "blueprint_action" && a.type !== "unsupported" && a.contactId &&
      (a.type !== "add_note" || a.note?.trim()) && (a.type !== "create_follow_up" || (a.taskTitle?.trim() && a.dueDate)));
    if (!supported) {
      await this.deps.reject(ctx.user!.id, turn.sessionId);
      return { text: "I need the exact contact and complete details before making this change. Please include the contact name, the note or follow-up, and a date if needed. Custom record edits and deletions still need the CRM Studio or Salesforce review screen." };
    }
    const details = proposal.actions.map(a => a.type === "add_note" ? `Add a note to ${a.contactName}: ${a.note}.`
      : a.type === "create_follow_up" ? `Create a follow-up for ${a.contactName}: ${a.taskTitle}, due ${a.dueDate} at 9 AM in ${proposal.timezone}.`
      : `Look up ${a.type !== "blueprint_action" ? a.contactName : "the record"}.`).join(" ");
    if (details.length > 1800) { await this.deps.reject(ctx.user!.id, turn.sessionId); return { text: "That change is too long to review clearly on a call. Please use dictation and the review screen, or ask for a shorter change." }; }
    const text = `${details} After I finish, say confirm change to approve, cancel change to discard, or tell me what to correct.`;
    const sessionId = turn.sessionId;
    call.pending = { id: randomUUID(), expires: Date.now() + 120_000, text,
      execute: async () => (await this.deps.confirm(ctx.user!.id, sessionId, proposal)).receipt,
      reject: () => this.deps.reject(ctx.user!.id, sessionId) };
    return { text, reviewId: call.pending.id };
  }
}

const calls = new VoiceCalls();
export const voiceCallRouter = router({
  start: protectedProcedure.input(z.object({ source: z.enum(["local", "hubspot", "both", "salesforce"]).default("local"), timezone: timezoneSchema, language: z.enum(["en", "ms"]).default("en") }))
    .mutation(({ ctx, input }) => calls.start(ctx, input)),
  turn: protectedProcedure.input(z.object({ callId: z.string().uuid(), requestId: z.string().uuid(), text: z.string().trim().min(1).max(4000), reviewedId: z.string().uuid().optional() }))
    .mutation(({ ctx, input }) => calls.turn(ctx, input)),
  end: protectedProcedure.input(z.object({ callId: z.string().uuid() })).mutation(({ ctx, input }) => calls.end(ctx, input.callId)),
});
