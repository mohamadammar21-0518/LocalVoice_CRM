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
  if (new URL(token.instance_url).origin !== config.login)
    fail(
      "Salesforce returned a different organisation. Check your configured My Domain."
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
  status: protectedProcedure.query(async ({ ctx }) => {
    let configured = false;
    let persistent = false,
      connection: Connection | undefined,
      connectionError: string | null = null;
    try {
      configuration();
      configured = true;
    } catch {
      /* Setup stays visible without leaking credentials. */
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
    });
    return { url: `${config.login}/services/oauth2/authorize?${params}` };
  }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    for (const [key, value] of pending)
      if (value.owner.id === ctx.user.id) pending.delete(key);
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
    try {
      const owner = await authenticateRequest(req);
      if (
        !owner ||
        owner.id !== entry.owner.id ||
        owner.sessionVersion !== entry.owner.sessionVersion ||
        entry.expires < Date.now()
      )
        throw new Error("Expired authorization");
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!code || code.length > 4096 || req.query.error)
        throw new Error("Authorization declined");
      await salesforceStore().exclusive(owner.id, async () => {
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
          currentOwner.id !== owner.id ||
          currentOwner.sessionVersion !== owner.sessionVersion ||
          pending.get(state) !== entry ||
          entry.expires < Date.now()
        )
          throw new Error("Authorization expired or superseded");
        await salesforceStore().save(owner, {
          version: owner.sessionVersion,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          instance: new URL(token.instance_url).origin,
        });
        pending.delete(state);
      });
      res.redirect(
        303,
        `${new URL(ENV.appOrigin).origin}/?salesforce=connected`
      );
    } catch {
      res.redirect(303, `${new URL(ENV.appOrigin).origin}/?salesforce=failed`);
    } finally {
      pending.delete(state);
    }
  });
}
