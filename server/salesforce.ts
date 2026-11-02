import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { parse } from "cookie";
import type { Express } from "express";
import { protectedProcedure, router } from "./_core/trpc";
import { authenticateRequest, localCookieOptions } from "./_core/localAuth";
import { ENV } from "./_core/env";
import { recordMetric } from "./metrics";
import {
  salesforceStore,
  type SalesforceConnection as Connection,
  type SalesforceOwner as Owner,
} from "./salesforceStore";

type Pending = {
  owner: Owner;
  verifier: string;
  expires: number;
  redirect: string;
};
const pending = new Map<string, Pending>();
const STATE_COOKIE = "localvoice_salesforce_state";
const recordId = z.string().regex(/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/);
const contactSchema = z.object({
  Id: recordId,
  Name: z.string(),
  Email: z.string().nullable(),
  Account: z.object({ Name: z.string() }).nullable(),
});
const taskSchema = z.object({
  Id: recordId,
  Subject: z.string(),
  Status: z.string(),
  Priority: z.string(),
  ActivityDate: z.string().nullable(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  instance_url: z.string().url(),
  refresh_token: z.string().optional(),
});

function configuration() {
  const clientId = process.env.SALESFORCE_CLIENT_ID?.trim();
  const loginValue = process.env.SALESFORCE_LOGIN_URL?.trim();
  if (!clientId || !loginValue)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Configure SALESFORCE_CLIENT_ID and SALESFORCE_LOGIN_URL on the server. See SALESFORCE_SETUP.md.",
    });
  const login = new URL(loginValue);
  if (
    login.protocol !== "https:" ||
    !/^[a-z0-9.-]+\.my\.salesforce\.com$/i.test(login.hostname) ||
    login.port ||
    login.username ||
    login.password ||
    login.pathname !== "/" ||
    login.search ||
    login.hash
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "SALESFORCE_LOGIN_URL must be your HTTPS My Domain origin, such as https://your-org.develop.my.salesforce.com",
    });
  const version = process.env.SALESFORCE_API_VERSION || "64.0";
  if (!/^\d{2,3}\.0$/.test(version))
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Invalid Salesforce API version",
    });
  return {
    clientId,
    login: login.origin,
    version,
    secret: process.env.SALESFORCE_CLIENT_SECRET?.trim(),
  };
}
function fail(message: string): never {
  throw new TRPCError({ code: "BAD_GATEWAY", message });
}
async function exchange(values: Record<string, string>) {
  const config = configuration();
  const response = await fetch(`${config.login}/services/oauth2/token`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...values,
      client_id: config.clientId,
      ...(config.secret ? { client_secret: config.secret } : {}),
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (
      values.grant_type === "refresh_token" &&
      body?.error === "invalid_grant"
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Salesforce authorization expired or was revoked. Connect Salesforce again.",
      });
    fail(
      "Salesforce authorization failed. Check app settings, callback URL and OAuth permissions, then reconnect."
    );
  }
  const token = tokenSchema.parse(await response.json());
  const instance = new URL(token.instance_url);
  if (
    instance.protocol !== "https:" ||
    !/^[a-z0-9.-]+\.my\.salesforce\.com$/i.test(instance.hostname) ||
    instance.port || instance.username || instance.password ||
    instance.pathname !== "/" || instance.search || instance.hash
  )
    fail(
      "Salesforce returned an untrusted organisation address. Check your configured My Domain."
    );
  return token;
}
async function refresh(owner: Owner, connection: Connection) {
  if (!connection.refreshToken) {
    await salesforceStore().remove(owner.id);
    fail("Salesforce session expired. Connect Salesforce again.");
  }
  let token: z.infer<typeof tokenSchema>;
  try {
    token = await exchange({
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
    });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED")
      await salesforceStore().remove(owner.id);
    throw error;
  }
  connection.accessToken = token.access_token;
  connection.refreshToken = token.refresh_token ?? connection.refreshToken;
  await salesforceStore().save(owner, connection);
}
async function query<T extends z.ZodType>(
  owner: Owner,
  soql: string,
  schema: T
) {
  const config = configuration();
  const store = salesforceStore();
  return store.exclusive(owner.id, async () => {
    const connection = await store.load(owner);
    if (!connection)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Connect your Salesforce account first",
      });
    const execute = () =>
      fetch(
        `${connection.instance}/services/data/v${config.version}/query?${new URLSearchParams({ q: soql })}`,
        {
          headers: { Authorization: `Bearer ${connection.accessToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        }
      );
    let response = await execute();
    if (response.status === 401) {
      await response.body?.cancel();
      await refresh(owner, connection);
      response = await execute();
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) {
        await store.remove(owner.id);
        fail("Salesforce session expired. Connect Salesforce again.");
      }
      if (response.status === 403)
        fail(
          "Salesforce denied access. Check API access and read permissions for Contacts, Accounts and Tasks."
        );
      if (response.status === 429)
        fail("Salesforce API limit reached. Please try again later.");
      fail(
        `Salesforce lookup failed (HTTP ${response.status}). Check permissions and the configured API version.`
      );
    }
    return z
      .object({
        records: z.array(schema),
        done: z.boolean(),
        totalSize: z.number(),
      })
      .parse(await response.json());
  });
}

const objectName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);
const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);
const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const recordFields = z.record(fieldName, scalar).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 30);
const objectSchema = z.object({ name: objectName, label: z.string(), queryable: z.boolean(), retrieveable: z.boolean(), createable: z.boolean(), updateable: z.boolean(), deletable: z.boolean() });
const fieldSchema = z.object({ name: fieldName, label: z.string(), type: z.string(), createable: z.boolean(), updateable: z.boolean(), accessible: z.boolean().optional(), filterable: z.boolean().optional(), nameField: z.boolean().optional(), nillable: z.boolean().optional(), length: z.number().optional(), picklistValues: z.array(z.object({ value: z.string(), label: z.string(), active: z.boolean() })).optional() });
const describeSchema = objectSchema.extend({ fields: z.array(fieldSchema) });
type SObject = z.infer<typeof objectSchema>;
type Field = z.infer<typeof fieldSchema>;
const editableTypes = new Set(["string", "textarea", "email", "phone", "url", "date", "datetime", "int", "double", "currency", "percent", "boolean", "picklist", "multipicklist", "reference"]);

const connectionKey = (connection: Connection) => connection.connectionId ?? createHash("sha256").update(`${connection.instance}:${connection.refreshToken ?? connection.accessToken}`).digest("hex");
async function salesforceRequest(owner: Owner, path: string, init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; connection?: string } = {}) {
  const config = configuration();
  const store = salesforceStore();
  return store.exclusive(owner.id, async () => {
    const connection = await store.load(owner);
    if (!connection) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect your Salesforce account first" });
    if (init.connection && init.connection !== connectionKey(connection)) throw new TRPCError({ code: "CONFLICT", message: "Salesforce account changed. Prepare a new review." });
    const execute = () => fetch(`${connection.instance}/services/data/v${config.version}/${path}`, {
      method: init.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${connection.accessToken}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    let response = await execute();
    if (response.status === 401) { await response.body?.cancel(); await refresh(owner, connection); response = await execute(); }
    if (!response.ok) {
      let detail = "";
      try { const errors = await response.json() as Array<{ message?: string }>; detail = Array.isArray(errors) ? errors.map(value => value.message).filter(Boolean).join("; ").slice(0, 400) : ""; } catch { await response.body?.cancel(); }
      if (response.status === 401) { await store.remove(owner.id); fail("Salesforce session expired. Connect Salesforce again."); }
      throw new TRPCError({ code: response.status === 404 ? "NOT_FOUND" : response.status === 403 ? "FORBIDDEN" : response.status === 429 ? "TOO_MANY_REQUESTS" : "BAD_GATEWAY", message: detail || `Salesforce request failed (HTTP ${response.status}). Check record access and field permissions.` });
    }
    if (response.status === 204) return null;
    return response.json() as Promise<unknown>;
  });
}
async function globalObjects(owner: Owner) {
  const result = z.object({ sobjects: z.array(objectSchema) }).parse(await salesforceRequest(owner, "sobjects"));
  return result.sobjects.filter(item => item.queryable || item.retrieveable || item.createable);
}
async function describe(owner: Owner, name: string) {
  const objects = await globalObjects(owner);
  const object = objects.find(item => item.name === name);
  if (!object) throw new TRPCError({ code: "NOT_FOUND", message: "Object is unavailable to this Salesforce user" });
  const detail = describeSchema.parse(await salesforceRequest(owner, `sobjects/${name}/describe`));
  return { ...detail, fields: detail.fields.filter(field => field.accessible !== false && (editableTypes.has(field.type) || field.name === "Id")) };
}
function convertField(field: Field, value: string | number | boolean | null) {
  if (value === null) { if (!field.nillable) throw new TRPCError({ code: "BAD_REQUEST", message: `${field.label} cannot be empty` }); return null; }
  if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (/^(true|yes|1)$/i.test(String(value))) return true;
    if (/^(false|no|0)$/i.test(String(value))) return false;
    throw new TRPCError({ code: "BAD_REQUEST", message: `${field.label} needs true or false` });
  }
  if (["int", "double", "currency", "percent"].includes(field.type)) {
    const number = Number(value);
    if (!Number.isFinite(number) || (field.type === "int" && !Number.isInteger(number))) throw new TRPCError({ code: "BAD_REQUEST", message: `${field.label} needs a number` });
    return number;
  }
  if (typeof value !== "string") throw new TRPCError({ code: "BAD_REQUEST", message: `${field.label} needs text` });
  const text = value.trim();
  if (field.length && text.length > field.length) throw new TRPCError({ code: "BAD_REQUEST", message: `${field.label} is too long` });
  if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TRPCError({ code: "BAD_REQUEST", message: `${field.label} needs YYYY-MM-DD` });
  if (field.type === "reference" && !recordId.safeParse(text).success) throw new TRPCError({ code: "BAD_REQUEST", message: `${field.label} needs a Salesforce record ID` });
  if (field.type === "picklist" && !field.picklistValues?.some(option => option.active && option.value === text)) throw new TRPCError({ code: "BAD_REQUEST", message: `${field.label} needs an available choice` });
  return text;
}
type Change = { owner: Owner; connection: string; object: string; operation: "create" | "update" | "delete"; recordId?: string; fields: Record<string, string | number | boolean | null>; label: string; expires: number; state: "pending" | "running" | "done"; result?: { id: string | null; deleted: boolean } };
const changes = new Map<string, Change>();
const escapeLike = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/[%_]/g, character => "\\" + character);
function contactQuery(input: string) {
  const name = input
    .trim()
    .replace(/^(?:find|look up|search for|cari)\s+/i, "")
    .replace(/[?.!]$/, "")
    .trim();
  if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Enter a contact name, for example Find Maya Chen",
    });
  return name;
}

export const salesforceRouter = router({
  objects: protectedProcedure.query(async ({ ctx }) => globalObjects(ctx.user)),
  describeObject: protectedProcedure.input(z.object({ object: objectName })).query(async ({ ctx, input }) => describe(ctx.user, input.object)),
  listRecords: protectedProcedure.input(z.object({ object: objectName, search: z.string().trim().max(100).default("") })).query(async ({ ctx, input }) => {
    const detail = await describe(ctx.user, input.object);
    if (!detail.queryable) throw new TRPCError({ code: "FORBIDDEN", message: "This object cannot be queried" });
    const title = detail.fields.find(field => field.nameField && field.filterable && ["string", "email", "phone"].includes(field.type));
    if (input.search && !title) throw new TRPCError({ code: "BAD_REQUEST", message: "This object does not support name search. Clear the search to browse it." });
    const selection = title ? `Id, ${title.name}` : "Id";
    const where = input.search && title ? ` WHERE ${title.name} LIKE '%${escapeLike(input.search)}%'` : "";
    const result = await query(ctx.user, `SELECT ${selection} FROM ${input.object}${where} LIMIT 51`, z.record(z.string(), z.unknown()));
    return { records: result.records.slice(0, 50).map(row => ({ Id: String(row.Id), label: title ? String(row[title.name] ?? row.Id) : String(row.Id) })), truncated: result.records.length > 50 || !result.done };
  }),
  getRecord: protectedProcedure.input(z.object({ object: objectName, id: recordId })).query(async ({ ctx, input }) => {
    const detail = await describe(ctx.user, input.object);
    if (!detail.retrieveable) throw new TRPCError({ code: "FORBIDDEN", message: "This object cannot be read" });
    const record = await salesforceRequest(ctx.user, `sobjects/${input.object}/${input.id}`);
    return { record: z.record(z.string(), z.unknown()).parse(record), fields: detail.fields.filter(field => field.updateable) };
  }),
  prepareChange: protectedProcedure.input(z.object({ object: objectName, operation: z.enum(["create", "update", "delete"]), id: recordId.optional(), fields: recordFields.optional() })).mutation(async ({ ctx, input }) => {
    const connection = await salesforceStore().exclusive(ctx.user.id, () => salesforceStore().load(ctx.user));
    if (!connection) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect Salesforce first." });
    const detail = await describe(ctx.user, input.object);
    if (!(input.operation === "create" ? detail.createable : input.operation === "update" ? detail.updateable : detail.deletable)) throw new TRPCError({ code: "FORBIDDEN", message: `You cannot ${input.operation} this Salesforce object` });
    if (input.operation !== "create" && !input.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a record first" });
    if (input.operation !== "delete" && !input.fields) throw new TRPCError({ code: "BAD_REQUEST", message: "Provide at least one field" });
    if (input.operation === "delete" && input.fields) throw new TRPCError({ code: "BAD_REQUEST", message: "Delete does not accept field values" });
    if (input.operation !== "create") await salesforceRequest(ctx.user, `sobjects/${input.object}/${input.id}`);
    const fields: Record<string, string | number | boolean | null> = {};
    for (const [name, value] of Object.entries(input.fields ?? {})) {
      const field = detail.fields.find(candidate => candidate.name === name);
      if (!field || !editableTypes.has(field.type) || !field[input.operation === "create" ? "createable" : "updateable"]) throw new TRPCError({ code: "FORBIDDEN", message: `${name} is not writable for this action` });
      fields[name] = convertField(field, value);
    }
    for (const [key, change] of changes) if (change.expires < Date.now()) changes.delete(key);
    if (changes.size >= 500) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many pending Salesforce changes" });
    const token = randomBytes(32).toString("base64url");
    const change: Change = { owner: { id: ctx.user.id, sessionVersion: ctx.user.sessionVersion }, connection: connectionKey(connection), object: input.object, operation: input.operation, recordId: input.id, fields, label: detail.label, expires: Date.now() + 10 * 60000, state: "pending" };
    changes.set(token, change);
    return { token, object: change.object, label: change.label, operation: change.operation, id: change.recordId ?? null, fields: change.fields, expires: change.expires };
  }),
  rejectChange: protectedProcedure.input(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })).mutation(({ ctx, input }) => {
    const change = changes.get(input.token);
    if (change?.owner.id === ctx.user.id && change.owner.sessionVersion === ctx.user.sessionVersion && change.state === "pending") changes.delete(input.token);
    return { cancelled: true };
  }),
  confirmChange: protectedProcedure.input(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), deleteText: z.string().optional() })).mutation(async ({ ctx, input }) => {
    const change = changes.get(input.token);
    if (!change || change.owner.id !== ctx.user.id || change.owner.sessionVersion !== ctx.user.sessionVersion || change.expires < Date.now()) throw new TRPCError({ code: "NOT_FOUND", message: "This change expired. Prepare it again." });
    if (change.state === "done") return change.result!;
    if (change.state === "running") throw new TRPCError({ code: "CONFLICT", message: "This change is already being saved" });
    if (change.operation === "delete" && input.deleteText !== "DELETE") throw new TRPCError({ code: "BAD_REQUEST", message: "Type DELETE to confirm deletion." });
    change.state = "running";
    try {
      let id = change.recordId ?? null;
      if (change.operation === "create") {
        const created = z.object({ id: recordId, success: z.boolean() }).parse(await salesforceRequest(ctx.user, `sobjects/${change.object}`, { method: "POST", body: change.fields, connection: change.connection }));
        if (!created.success) fail("Salesforce did not create the record");
        id = created.id;
      } else await salesforceRequest(ctx.user, `sobjects/${change.object}/${id}`, { method: change.operation === "delete" ? "DELETE" : "PATCH", connection: change.connection, ...(change.operation === "delete" ? {} : { body: change.fields }) });
      change.result = { id, deleted: change.operation === "delete" }; change.state = "done";
      return change.result;
    } catch (error) { changes.delete(input.token); throw error; }
  }),
  status: protectedProcedure.query(async ({ ctx }) => {
    let configured = false;
    let persistent = false,
      connection: Connection | undefined,
      connectionError: string | null = null;
    try {
      configuration();
      configured = true;
    } catch (error) {
      // Only expose our own configuration guidance, never raw URL/parser errors.
      connectionError = error instanceof TRPCError
        ? error.message
        : "SALESFORCE_LOGIN_URL must be a valid HTTPS My Domain URL. Check the server configuration.";
    }
    if (configured) {
      try {
        const store = salesforceStore();
        persistent = store.persistent;
        connection = await store.exclusive(ctx.user.id, () =>
          store.load(ctx.user)
        );
      } catch {
        connectionError =
          "Saved connection unavailable. Check server configuration, then disconnect and reconnect Salesforce.";
      }
    }
    return {
      configured,
      connected: Boolean(connection),
      persistent,
      connectionError,
      organisation: connection ? new URL(connection.instance).hostname : null,
      callbackUrl: `${new URL(ENV.appOrigin).origin}/api/salesforce/callback`,
    };
  }),
  timingMetric: protectedProcedure
    .input(
      z.object({
        requestId: z.string().uuid(),
        stage: z.enum(["intent", "retrieval", "first_audio"]),
        outcome: z.enum(["ok", "error", "cancelled"]).default("ok"),
        durationMs: z.number().int().min(0).max(300000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await recordMetric({
        userId: ctx.user.id,
        requestId: input.requestId,
        stage: input.stage,
        outcome: input.outcome,
        durationMs: input.durationMs,
      });
      return { recorded: true };
    }),
  connect: protectedProcedure.mutation(({ ctx }) => {
    const config = configuration();
    salesforceStore();
    for (const [key, change] of changes) if (change.owner.id === ctx.user.id) changes.delete(key);
    if (ctx.req.get("host") !== new URL(ENV.appOrigin).host)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Open ${new URL(ENV.appOrigin).origin} and sign in there before connecting Salesforce.`,
      });
    for (const [key, value] of pending)
      if (value.expires < Date.now() || value.owner.id === ctx.user.id)
        pending.delete(key);
    if (pending.size >= 500)
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Connection capacity reached. Please try later.",
      });
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    const redirect = `${new URL(ENV.appOrigin).origin}/api/salesforce/callback`;
    pending.set(state, {
      owner: { id: ctx.user.id, sessionVersion: ctx.user.sessionVersion },
      verifier,
      expires: Date.now() + 10 * 60000,
      redirect,
    });
    ctx.res.cookie(STATE_COOKIE, state, {
      ...localCookieOptions(ctx.req),
      maxAge: 10 * 60000,
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirect,
      scope: "api refresh_token",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "login",
    });
    return { url: `${config.login}/services/oauth2/authorize?${params}` };
  }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    for (const [key, value] of pending)
      if (value.owner.id === ctx.user.id) pending.delete(key);
    for (const [key, change] of changes) if (change.owner.id === ctx.user.id) changes.delete(key);
    const store = salesforceStore();
    return store.exclusive(ctx.user.id, async () => {
      let connection: Connection | undefined;
      let revoked = true;
      try {
        connection = await store.load(ctx.user);
      } catch {
        revoked = false;
      }
      await store.remove(ctx.user.id);
      if (connection) {
        try {
          const response = await fetch(
            `${configuration().login}/services/oauth2/revoke`,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(10000),
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: connection.refreshToken ?? connection.accessToken,
              }),
            }
          );
          revoked = response.ok;
          await response.body?.cancel();
        } catch {
          revoked = false;
        }
      }
      return { disconnected: true, revoked };
    });
  }),
  findContact: protectedProcedure
    .input(z.object({ request: z.string().trim().min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const name = contactQuery(input.request);
      const result = await query(
        ctx.user,
        `SELECT Id, Name, Email, Account.Name FROM Contact WHERE Name LIKE '%${escapeLike(name)}%' ORDER BY Name, Id LIMIT 21`,
        contactSchema
      );
      return {
        contacts: result.records.slice(0, 20),
        truncated: result.records.length > 20 || !result.done,
      };
    }),
  openTasks: protectedProcedure
    .input(z.object({ contactId: recordId }))
    .query(async ({ ctx, input }) => {
      const contact = await query(
        ctx.user,
        `SELECT Id, Name, Email, Account.Name FROM Contact WHERE Id = '${input.contactId}' LIMIT 1`,
        contactSchema
      );
      if (!contact.records[0])
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contact not found or inaccessible in Salesforce",
        });
      const result = await query(
        ctx.user,
        `SELECT Id, Subject, Status, Priority, ActivityDate FROM Task WHERE WhoId = '${input.contactId}' AND IsClosed = false ORDER BY ActivityDate ASC NULLS LAST, Id LIMIT 101`,
        taskSchema
      );
      return {
        contact: contact.records[0],
        tasks: result.records.slice(0, 100),
        truncated: result.records.length > 100 || !result.done,
      };
    }),
});

export function registerSalesforceCallback(app: Express) {
  app.get("/api/salesforce/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const cookieState = parse(req.headers.cookie ?? "")[STATE_COOKIE] ?? "";
    const entry = pending.get(state);
    if (
      !/^[a-zA-Z0-9_-]{43}$/.test(state) ||
      !/^[a-zA-Z0-9_-]{43}$/.test(cookieState) ||
      !entry ||
      state.length !== cookieState.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(cookieState))
    ) {
      res
        .status(400)
        .send(
          "Salesforce connection could not be verified. Return to the CRM and connect again."
        );
      return;
    }
    res.clearCookie(STATE_COOKIE, localCookieOptions(req));
    let owner: Owner | null = null;
    try {
      const authenticatedOwner = await authenticateRequest(req);
      if (
        !authenticatedOwner ||
        authenticatedOwner.id !== entry.owner.id ||
        authenticatedOwner.sessionVersion !== entry.owner.sessionVersion ||
        entry.expires < Date.now()
      )
        throw new Error("Expired authorization");
      owner = authenticatedOwner;
      const authorizedOwner = authenticatedOwner;
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!code || code.length > 4096 || req.query.error)
        throw new Error("Authorization declined");
      await salesforceStore().exclusive(authorizedOwner.id, async () => {
        if (pending.get(state) !== entry)
          throw new Error("Authorization superseded");
        const token = await exchange({
          grant_type: "authorization_code",
          code,
          redirect_uri: entry.redirect,
          code_verifier: entry.verifier,
        });
        const currentOwner = await authenticateRequest(req);
        if (
          !currentOwner ||
          currentOwner.id !== authorizedOwner.id ||
          currentOwner.sessionVersion !== authorizedOwner.sessionVersion ||
          pending.get(state) !== entry ||
          entry.expires < Date.now()
        )
          throw new Error("Authorization expired or superseded");
        await salesforceStore().save(authorizedOwner, {
          connectionId: randomBytes(24).toString("base64url"),
          version: authorizedOwner.sessionVersion,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          instance: new URL(token.instance_url).origin,
        });
        pending.delete(state);
      });
      // Validate API access and warm object metadata immediately. This makes a
      // completed Salesforce login usable without a manual refresh or search.
      await globalObjects(authorizedOwner);
      res.redirect(
        303,
        `${new URL(ENV.appOrigin).origin}/?salesforce=connected`
      );
    } catch {
      if (owner) await salesforceStore().remove(owner.id).catch(() => {});
      res.redirect(303, `${new URL(ENV.appOrigin).origin}/?salesforce=failed`);
    } finally {
      pending.delete(state);
    }
  });
}
