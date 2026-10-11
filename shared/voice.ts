import { z } from "zod";

export const timezoneSchema = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}, "Choose a valid timezone");
export const sourceSchema = z.enum(["local", "hubspot", "both"]);
export const proposalActionSchema = z.object({
  type: z.string().max(40).transform(value => {
    const aliases: Record<string, "lookup_contact" | "add_note" | "create_follow_up" | "unsupported"> = {
      lookup_contact: "lookup_contact", lookup: "lookup_contact", search: "lookup_contact",
      note: "add_note", add_note: "add_note", addnote: "add_note",
      task: "create_follow_up", follow_up: "create_follow_up", followup: "create_follow_up", create_follow_up: "create_follow_up",
      unsupported: "unsupported",
    };
    return aliases[value.toLowerCase().replace(/[\s-]+/g, "_")] ?? "unsupported";
  }),
  contactId: z.number().int().positive().nullable().optional(),
  contactName: z.string().max(240).nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
  taskTitle: z.string().max(240).nullable().optional(),
  dueDate: z.string().max(80).nullable().optional(),
  dateExpression: z.string().max(100).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
});
export const proposalSchema = z.object({
  actions: z.array(proposalActionSchema).min(1).max(5),
  summary: z.string().max(1000).nullable().optional(),
  version: z.number().int().nonnegative().default(0),
  timezone: timezoneSchema.default("Asia/Kuala_Lumpur"),
});
export type ProposalAction = z.infer<typeof proposalActionSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ContactChoice = { id: number; name: string; company: string | null; email: string | null };
export type ReviewedProposal = Omit<Proposal, "actions"> & { actions: (ProposalAction & { candidates: ContactChoice[] })[] };
export type CrmSource = z.infer<typeof sourceSchema>;
export type VoiceSource = { kind: "contact" | "interaction" | "task" | "dashboard"; id: string; label: string; provider: "local" | "hubspot" };
export type VoiceTurn = { text: string; sources: VoiceSource[]; sessionId: number | null; proposal: ReviewedProposal | null; warnings: string[]; llmMs: number; retrievalMs: number; inputTokens: number; outputTokens: number; loadMs: number };
export const voiceRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(10000),
  sessionId: z.number().int().positive().nullable().optional(),
  source: sourceSchema.default("local"),
  timezone: timezoneSchema.default("Asia/Kuala_Lumpur"),
  contactId: z.number().int().positive().nullable().optional(),
  speak: z.boolean().default(true),
  responseLanguage: z.enum(["en", "ms"]).default("en"),
});
