import { z } from "zod";
import { ENV } from "./_core/env";
import { hubspotAccess } from "./hubspotAuth";

const BASE = "https://api.hubapi.com";
const remoteObjectSchema = z.object({ id: z.string(), properties: z.record(z.string(), z.string().nullable()), associations: z.record(z.string(), z.object({ results: z.array(z.object({ id: z.string() })), paging: z.unknown().optional() })).optional() });
const pageSchema = z.object({ results: z.array(remoteObjectSchema), paging: z.object({ next: z.object({ after: z.union([z.string(), z.number()]) }) }).optional() });
export type RemoteObject = z.infer<typeof remoteObjectSchema>;
export type HubSpotPage = { results: RemoteObject[]; after: string | null };
export class HubSpotConfigurationError extends Error { constructor() { super("HubSpot is not configured. Add HUBSPOT_ACCESS_TOKEN to enable it."); } }
export class HubSpotRequestError extends Error {
  constructor(public status: number | null) { super(status ? `HubSpot returned HTTP ${status}` : "HubSpot response is uncertain; check the remote record before retrying"); }
}
export function isHubSpotConfigured() { return Boolean(hubspotAccess() ? hubspotAccess()!.token : ENV.hubspotToken.trim()); }
export async function hubspotRequest(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const token = hubspotAccess() ? hubspotAccess()!.token : ENV.hubspotToken.trim();
  if (!token) throw new HubSpotConfigurationError();
  try {
    const requestSignal = AbortSignal.any([AbortSignal.timeout(ENV.hubspotTimeoutMs), ...(signal ? [signal] : [])]);
    const options = { ...init, signal: requestSignal, headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
    let response = await fetch(`${BASE}${path}`, options);
    if (response.status === 429 && (!init.method || init.method === "GET")) {
      const seconds = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 2000) : 500;
      await response.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        if (requestSignal.aborted) { reject(requestSignal.reason); return; }
        const onAbort = () => { clearTimeout(timer); reject(requestSignal.reason); };
        const timer = setTimeout(() => { requestSignal.removeEventListener("abort", onAbort); resolve(); }, delay);
        requestSignal.addEventListener("abort", onAbort, { once: true });
      });
      response = await fetch(`${BASE}${path}`, options);
    }
    if (!response.ok) { await response.body?.cancel(); throw new HubSpotRequestError(response.status); }
    if (response.status === 204) return {};
    return await response.json();
  } catch (error) { if (error instanceof HubSpotRequestError) throw error; throw new HubSpotRequestError(null); }
}
const properties = {
  contacts: ["firstname", "lastname", "email", "phone", "jobtitle", "company"],
  notes: ["hs_note_body", "hs_timestamp"],
  tasks: ["hs_task_subject", "hs_task_body", "hs_task_status", "hs_timestamp"],
};
export async function listHubSpotPage(kind: keyof typeof properties, after?: string, signal?: AbortSignal): Promise<HubSpotPage> {
  const params = new URLSearchParams({ limit: "100", properties: properties[kind].join(",") });
  if (kind !== "contacts") params.set("associations", "contacts");
  if (after) params.set("after", after);
  const page = pageSchema.parse(await hubspotRequest(`/crm/v3/objects/${kind}?${params}`, {}, signal));
  return { results: page.results, after: page.paging?.next ? String(page.paging.next.after) : null };
}
export async function getHubSpotObject(kind: keyof typeof properties, id: string, signal?: AbortSignal) {
  return remoteObjectSchema.parse(await hubspotRequest(`/crm/v3/objects/${kind}/${encodeURIComponent(id)}?properties=${properties[kind].join(",")}${kind !== "contacts" ? "&associations=contacts" : ""}`, {}, signal));
}
export async function getAssociatedRecords(contactId: string, kind: "notes" | "tasks", signal?: AbortSignal) {
  const raw = z.object({ results: z.array(z.object({ toObjectId: z.union([z.number(), z.string()]) })), paging: z.unknown().optional() }).parse(await hubspotRequest(`/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/${kind}?limit=100`, {}, signal));
  if (!raw.results.length) return { results: [] as RemoteObject[], truncated: Boolean(raw.paging) };
  const records = z.object({ results: z.array(remoteObjectSchema) }).parse(await hubspotRequest(`/crm/v3/objects/${kind}/batch/read`, { method: "POST", body: JSON.stringify({ inputs: raw.results.map(item => ({ id: String(item.toObjectId) })), properties: properties[kind] }) }, signal));
  return { results: records.results, truncated: Boolean(raw.paging) };
}
export const plainText = (value: string | null | undefined) => (value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const create = (kind: string, values: Record<string, string>, association?: { contactId: string; type: number }) => hubspotRequest(`/crm/v3/objects/${kind}`, { method: "POST", body: JSON.stringify({ properties: values, ...(association ? { associations: [{ to: { id: association.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: association.type }] }] } : {}) }) }).then(value => remoteObjectSchema.parse(value));
const update = (kind: string, id: string, values: Record<string, string>) => hubspotRequest(`/crm/v3/objects/${kind}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ properties: values }) }).then(value => remoteObjectSchema.parse(value));
export const hubspot = {
  status: () => ({ configured: isHubSpotConfigured(), provider: "HubSpot", mode: isHubSpotConfigured() ? "external" : "local" }),
  requireConfigured: () => { if (!isHubSpotConfigured()) throw new HubSpotConfigurationError(); },
  listContacts: () => listHubSpotPage("contacts"),
  createContact: (values: Record<string, string>) => create("contacts", values),
  updateContact: (id: string, values: Record<string, string>) => update("contacts", id, values),
  createNote: (contactId: string, body: string) => create("notes", { hs_timestamp: new Date().toISOString(), hs_note_body: body }, { contactId, type: 202 }),
  updateNote: (id: string, body: string) => update("notes", id, { hs_note_body: body }),
  createTask: (contactId: string, subject: string, dueAt: Date, completed = false) => create("tasks", { hs_timestamp: dueAt.toISOString(), hs_task_subject: subject, hs_task_status: completed ? "COMPLETED" : "NOT_STARTED" }, { contactId, type: 204 }),
  updateTask: (id: string, subject: string, dueAt: Date, completed = false) => update("tasks", id, { hs_timestamp: dueAt.toISOString(), hs_task_subject: subject, hs_task_status: completed ? "COMPLETED" : "NOT_STARTED" }),
};
