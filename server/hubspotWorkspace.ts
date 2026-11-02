import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "./_core/trpc";
import { hubspotProcedure as adminProcedure, hubspotConnectionProcedures, hubspotIdentity, hubspotAccess } from "./hubspotAuth";
import { hubspotRequest, HubSpotRequestError, isHubSpotConfigured } from "./hubspot";
import type { TrpcContext } from "./_core/context";

export const hubspotObjects = ["contacts", "companies", "deals", "tickets", "tasks", "notes", "calls", "emails", "meetings", "products", "line_items", "quotes"] as const;
export const hubspotObject = z.string().regex(/^(contacts|companies|deals|tickets|tasks|notes|calls|emails|meetings|products|line_items|quotes|2-\d+)$/);
const idSchema = z.string().regex(/^\d+$/).max(40);
const propertySchema = z.object({ name: z.string(), label: z.string(), type: z.string(), fieldType: z.string().optional(), groupName: z.string().optional(), hidden: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).default([]), modificationMetadata: z.object({ readOnlyValue: z.boolean().optional() }).optional(), calculated: z.boolean().optional() });
export type HubSpotProperty = z.infer<typeof propertySchema>;
const recordSchema = z.object({ id: z.string(), properties: z.record(z.string(), z.string().nullable()), updatedAt: z.string().optional(), createdAt: z.string().optional() });
const pageSchema = z.object({ results: z.array(recordSchema), total: z.number().optional(), paging: z.object({ next: z.object({ after: z.union([z.string(), z.number()]) }) }).optional() });
const metadata = new Map<string, { expires: number; properties: HubSpotProperty[] }>();
export async function hsRequest(path: string, init?: RequestInit) {
  try { return await hubspotRequest(path, init); }
  catch (e) {
    if (e instanceof HubSpotRequestError) {
      const message = e.status === 403 ? "HubSpot denied access. Add the matching object read/write and schema scopes to your private app."
        : e.status === 401 ? "HubSpot rejected the token. Update HUBSPOT_ACCESS_TOKEN and restart the app."
        : e.status === 429 ? "HubSpot rate limit reached. Please wait and try again."
        : e.status === 404 ? "This HubSpot object or record is unavailable for your account."
        : `HubSpot request failed${e.status ? ` (HTTP ${e.status})` : " or timed out"}.`;
      throw new TRPCError({ code: e.status === 403 ? "FORBIDDEN" : e.status === 404 ? "NOT_FOUND" : "BAD_GATEWAY", message, cause: e });
    }
    throw e;
  }
}
export async function hsProperties(object: string) {
  hubspotObject.parse(object);
  const key = `${hubspotIdentity()}:${object}`;
  const cached = metadata.get(key); if (cached && cached.expires > Date.now()) return cached.properties;
  const { results } = z.object({ results: z.array(propertySchema) }).parse(await hsRequest(`/crm/v3/properties/${object}`));
  if (metadata.size > 1000) metadata.clear();
  metadata.set(key, { expires: Date.now() + 300_000, properties: results });
  return results;
}
const primary: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "company"], companies: ["name", "domain", "phone", "industry"],
  deals: ["dealname", "amount", "dealstage", "closedate"], tickets: ["subject", "hs_pipeline_stage", "hs_ticket_priority"],
  tasks: ["hs_task_subject", "hs_task_status", "hs_timestamp"], notes: ["hs_note_body", "hs_timestamp"],
  calls: ["hs_call_title", "hs_call_body", "hs_timestamp"], emails: ["hs_email_subject", "hs_email_text", "hs_timestamp"],
  meetings: ["hs_meeting_title", "hs_meeting_body", "hs_timestamp"], products: ["name", "price", "hs_sku"],
  line_items: ["name", "price", "quantity"], quotes: ["hs_title", "hs_status"],
};
export async function hsList(input: { object: string; query?: string; after?: string; limit?: number }) {
  const properties = await hsProperties(input.object);
  const names = (primary[input.object] ?? properties.filter(p => !p.hidden).slice(0, 6).map(p => p.name)).filter(name => properties.some(p => p.name === name));
  const limit = input.limit ?? 50;
  const raw = input.query?.trim()
    ? await hsRequest(`/crm/v3/objects/${input.object}/search`, { method: "POST", body: JSON.stringify({ query: input.query.trim(), limit, properties: names, ...(input.after ? { after: input.after } : {}) }) })
    : await hsRequest(`/crm/v3/objects/${input.object}?${new URLSearchParams({ limit: String(limit), properties: names.join(","), ...(input.after ? { after: input.after } : {}) })}`);
  const page = pageSchema.parse(raw);
  return { records: page.results, after: page.paging?.next ? String(page.paging.next.after) : null, total: page.total, columns: names };
}
export async function hsGet(object: string, id: string) {
  idSchema.parse(id); const properties = await hsProperties(object);
  const page = pageSchema.parse(await hsRequest(`/crm/v3/objects/${object}/batch/read`, { method: "POST", body: JSON.stringify({ inputs: [{ id }], properties: properties.map(p => p.name) }) }));
  if (!page.results[0]) throw new TRPCError({ code: "NOT_FOUND", message: "HubSpot record not found." });
  return page.results[0];
}
export function hsLabel(properties: Record<string, string | null>) {
  return properties.name || properties.dealname || properties.subject || properties.hs_task_subject || properties.hs_title || properties.hs_call_title || properties.hs_email_subject || properties.hs_meeting_title || [properties.firstname, properties.lastname].filter(Boolean).join(" ") || properties.email || "Record";
}
const changesSchema = z.object({ object: hubspotObject, operation: z.enum(["create", "update", "delete"]), recordId: idSchema.optional(), values: z.record(z.string().max(100), z.string().max(8000)).default({}) });
type Changes = z.infer<typeof changesSchema>;
type Draft = Changes & { id: string; owner: number; connection: string; version: number; expires: number; before: z.infer<typeof recordSchema> | null; state: "pending" | "executing" | "done" | "failed" | "uncertain"; receipt?: string };
const drafts = new Map<string, Draft>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requireAdmin = (ctx: TrpcContext) => { if (!ctx.user || (ctx.user.role !== "admin" && hubspotAccess()?.mode !== "oauth")) throw new TRPCError({ code: "FORBIDDEN", message: "Connect your own HubSpot account first." }); };
export async function hsDraft(ctx: TrpcContext, input: Changes) {
  requireAdmin(ctx); changesSchema.parse(input);
  for (const [id, draft] of drafts) if (draft.expires < Date.now() && draft.state !== "executing") drafts.delete(id);
  if (drafts.size > 200) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Review existing changes first." });
  const metadata = await hsProperties(input.object);
  if (input.operation !== "create" && !input.recordId) throw new TRPCError({ code: "BAD_REQUEST", message: "Select a specific record." });
  if (input.operation !== "delete" && !Object.keys(input.values).length) throw new TRPCError({ code: "BAD_REQUEST", message: "Supply at least one changed field." });
  for (const [key, value] of Object.entries(input.values)) {
    const prop = metadata.find(p => p.name === key);
    if (!prop || prop.calculated || prop.modificationMetadata?.readOnlyValue) throw new TRPCError({ code: "BAD_REQUEST", message: `Field ${key} cannot be written.` });
    if (value && prop.type === "number" && !Number.isFinite(Number(value))) throw new TRPCError({ code: "BAD_REQUEST", message: `${prop.label} needs a number.` });
    if (value && prop.options.length && value.split(";").some(item => !prop.options.some(option => option.value === item))) throw new TRPCError({ code: "BAD_REQUEST", message: `Choose a valid ${prop.label} value.` });
  }
  const before = input.operation === "create" ? null : await hsGet(input.object, input.recordId!);
  const draft: Draft = { ...input, values: input.operation === "delete" ? {} : input.values, id: randomUUID(), owner: ctx.user!.id, connection: hubspotIdentity(), version: ctx.user!.sessionVersion, before, expires: Date.now() + 300_000, state: "pending" };
  drafts.set(draft.id, draft);
  return { id: draft.id, operation: draft.operation, object: draft.object, recordId: draft.recordId, values: draft.values, label: hsLabel(before?.properties ?? input.values), before: before?.properties ?? null };
}
function ownedDraft(ctx: TrpcContext, id: string) {
  requireAdmin(ctx); const draft = drafts.get(id);
  if (!draft || draft.owner !== ctx.user!.id || draft.version !== ctx.user!.sessionVersion) throw new TRPCError({ code: "NOT_FOUND", message: "Review unavailable. Prepare the change again." });
  if (draft.connection !== hubspotIdentity()) throw new TRPCError({ code: "CONFLICT", message: "HubSpot account changed. Prepare a new review." });
  return draft;
}
export async function hsConfirm(ctx: TrpcContext, id: string, deleteText?: string) {
  const draft = ownedDraft(ctx, id);
  if (draft.state === "done") return { message: draft.receipt!, replayed: true };
  if (draft.expires < Date.now() || draft.state !== "pending") throw new TRPCError({ code: "CONFLICT", message: "This review expired or was already attempted. Verify the HubSpot record before making a new request." });
  if (draft.operation === "delete" && deleteText !== "DELETE") throw new TRPCError({ code: "BAD_REQUEST", message: "Confirm the deletion explicitly." });
  draft.state = "executing";
  let sent = false;
  try {
    if (draft.before && hash(await hsGet(draft.object, draft.recordId!)) !== hash(draft.before)) throw new TRPCError({ code: "CONFLICT", message: "The HubSpot record changed. Review it again." });
    const endpoint = `/crm/v3/objects/${draft.object}${draft.operation === "create" ? "" : `/${draft.recordId}`}`;
    sent = true;
    await hsRequest(endpoint, { method: draft.operation === "create" ? "POST" : draft.operation === "update" ? "PATCH" : "DELETE", ...(draft.operation === "delete" ? {} : { body: JSON.stringify({ properties: draft.values }) }) });
    draft.state = "done"; draft.receipt = `${draft.operation === "delete" ? "Archived" : draft.operation === "create" ? "Created" : "Updated"} ${draft.object} in HubSpot.`;
    return { message: draft.receipt, replayed: false };
  } catch (e) { draft.state = sent ? "uncertain" : "failed"; throw e; }
}
export function hsReject(ctx: TrpcContext, id: string) { const draft = ownedDraft(ctx, id); if (draft.state === "pending") draft.state = "failed"; return { cancelled: draft.state === "failed" }; }

export const hubspotWorkspaceRouter = router({
  ...hubspotConnectionProcedures,
  status: adminProcedure.query(async () => {
    if (!isHubSpotConfigured()) return { configured: false, connected: false, message: "Connect your HubSpot account to browse its CRM records." };
    try { await hsRequest("/crm/v3/objects/contacts?limit=1"); return { configured: true, connected: true, message: "HubSpot contact access verified. Other objects are checked when opened." }; }
    catch (e) { return { configured: true, connected: false, message: (e as Error).message }; }
  }),
  objects: adminProcedure.query(async () => {
    let warning = ""; let custom: { key: string; label: string }[] = [];
    try {
      const data = z.object({ results: z.array(z.object({ objectTypeId: z.string(), labels: z.object({ plural: z.string() }) })) }).parse(await hsRequest("/crm/v3/schemas"));
      custom = data.results.filter(o => /^2-\d+$/.test(o.objectTypeId)).map(o => ({ key: o.objectTypeId, label: o.labels.plural }));
    } catch (e) { warning = `Custom object discovery: ${(e as Error).message}`; }
    return { objects: [...hubspotObjects.map(key => ({ key, label: key.replaceAll("_", " ") })), ...custom], warning };
  }),
  properties: adminProcedure.input(z.object({ object: hubspotObject })).query(({ input }) => hsProperties(input.object)),
  records: adminProcedure.input(z.object({ object: hubspotObject, query: z.string().max(200).optional(), after: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).default(50) })).query(({ input }) => hsList(input)),
  record: adminProcedure.input(z.object({ object: hubspotObject, id: idSchema })).query(({ input }) => hsGet(input.object, input.id)),
  associations: adminProcedure.input(z.object({ object: hubspotObject, id: idSchema, target: hubspotObject, after: z.string().max(100).optional() })).query(async ({ input }) => {
    const params = new URLSearchParams({ limit: "100", ...(input.after ? { after: input.after } : {}) });
    return z.object({ results: z.array(z.object({ toObjectId: z.union([z.string(), z.number()]) })), paging: z.object({ next: z.object({ after: z.union([z.string(), z.number()]) }) }).optional() }).parse(await hsRequest(`/crm/v4/objects/${input.object}/${input.id}/associations/${input.target}?${params}`));
  }),
  draft: adminProcedure.input(changesSchema).mutation(({ ctx, input }) => hsDraft(ctx, input)),
  confirm: adminProcedure.input(z.object({ id: z.string().uuid(), deleteText: z.string().optional() })).mutation(({ ctx, input }) => hsConfirm(ctx, input.id, input.deleteText)),
  reject: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ ctx, input }) => hsReject(ctx, input.id)),
});
