import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "cookie";
import type { Express } from "express";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ENV } from "./_core/env";
import { protectedProcedure } from "./_core/trpc";
import { authenticateRequest, localCookieOptions } from "./_core/localAuth";

type Owner = { id: number; sessionVersion: number; role: string };
const savedSchema = z.object({ generation: z.string(), mode: z.enum(["oauth", "server", "disconnected"]), accessToken: z.string().optional(), refreshToken: z.string().optional(), expires: z.number().optional(), hubId: z.number().optional() });
type Saved = z.infer<typeof savedSchema>;
const memory = new Map<number, Saved>();
const locks = new Map<number, Promise<unknown>>();
export async function hubspotExclusive<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn); locks.set(id, next);
  try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
}
function encryptionKey() {
  const value = process.env.HUBSPOT_TOKEN_ENCRYPTION_KEY || process.env.SALESFORCE_TOKEN_ENCRYPTION_KEY;
  if (!value) return undefined;
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Configure a valid 32-byte HubSpot token encryption key." });
  return key;
}
function filename(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid owner");
  return path.resolve(".localvoice-private/hubspot", `${id}.json`);
}
const aad = (id: number) => Buffer.from(`localvoice:hubspot:${id}:${process.env.HUBSPOT_CLIENT_ID ?? ""}`);
async function load(id: number): Promise<Saved | undefined> {
  const key = encryptionKey(); if (!key) return memory.get(id);
  try {
    const raw = await fs.readFile(filename(id), "utf8");
    if (raw.length > 65536) throw new Error("Invalid file");
    const envelope = JSON.parse(raw);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(id)); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return savedSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Saved HubSpot connection cannot be opened. Disconnect and reconnect." });
  }
}
async function save(id: number, value: Saved) {
  const key = encryptionKey(); if (!key) { memory.set(id, value); return; }
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad(id));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  const target = filename(id), temp = `${target}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(temp, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { flag: "wx", mode: 0o600 }); await fs.rename(temp, target); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
export const hubspotOAuthConfigured = () => Boolean(process.env.HUBSPOT_CLIENT_ID?.trim() && process.env.HUBSPOT_CLIENT_SECRET?.trim());
const callbackUrl = () => `${new URL(ENV.appOrigin).origin}/api/hubspot/callback`;
const tokens = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive(), hub_id: z.number().optional() });
async function exchange(values: Record<string, string>) {
  if (!hubspotOAuthConfigured()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET on the server to enable HubSpot login." });
  const response = await fetch("https://api.hubapi.com/oauth/v3/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...values, client_id: process.env.HUBSPOT_CLIENT_ID!.trim(), client_secret: process.env.HUBSPOT_CLIENT_SECRET!.trim() }) });
  if (!response.ok) { await response.body?.cancel(); throw new TRPCError({ code: "PRECONDITION_FAILED", message: "HubSpot authorization failed. Check app scopes and callback settings, then reconnect." }); }
  return tokens.parse(await response.json());
}
type Access = { token?: string; identity: string; mode: string; hubId?: number };
const access = new AsyncLocalStorage<Access>();
export const hubspotAccess = () => access.getStore();
export const hubspotIdentity = () => access.getStore()?.identity ?? "legacy-server";
async function resolve(owner: Owner): Promise<Access> {
  const stored = await load(owner.id);
  if (stored?.mode === "oauth") {
    if ((stored.expires ?? 0) < Date.now() + 60000) {
      if (!stored.refreshToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Reconnect HubSpot." });
      const token = await exchange({ grant_type: "refresh_token", refresh_token: stored.refreshToken });
      stored.accessToken = token.access_token; stored.refreshToken = token.refresh_token ?? stored.refreshToken; stored.expires = Date.now() + token.expires_in * 1000;
      await save(owner.id, stored);
    }
    return { token: stored.accessToken, identity: `${owner.id}:${stored.generation}`, mode: "oauth", hubId: stored.hubId };
  }
  const token = stored?.mode !== "disconnected" && owner.role === "admin" ? ENV.hubspotToken.trim() : undefined;
  return { token, identity: `${owner.id}:${stored?.generation ?? createHash("sha256").update(token ?? "").digest("hex")}`, mode: token ? "server" : "disconnected" };
}
export function withHubspot<T>(owner: Owner, fn: () => Promise<T>) {
  return hubspotExclusive(owner.id, async () => access.run(await resolve(owner), fn));
}
export const hubspotProcedure = protectedProcedure.use(({ ctx, next }) => withHubspot(ctx.user, () => next()));
const pending = new Map<string, { owner: Owner; expires: number }>();
const cookieName = "localvoice_hubspot_state";
export const hubspotConnectionProcedures = {
  connection: protectedProcedure.query(async ({ ctx }) => hubspotExclusive(ctx.user.id, async () => {
    let saved: Saved | undefined, error: string | undefined;
    try { saved = await load(ctx.user.id); } catch (e) { error = (e as Error).message; }
    return { oauthConfigured: hubspotOAuthConfigured(), callbackUrl: callbackUrl(), persistent: !!encryptionKey(), mode: error ? "unavailable" : saved?.mode ?? (ctx.user.role === "admin" && ENV.hubspotToken ? "server" : "disconnected"), hubId: saved?.hubId, error, serverTokenAvailable: ctx.user.role === "admin" && !!ENV.hubspotToken };
  })),
  connect: protectedProcedure.mutation(({ ctx }) => hubspotExclusive(ctx.user.id, async () => {
    if (!hubspotOAuthConfigured()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Configure HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET first. A private-app token cannot provide account login." });
    for (const [key, item] of pending) if (item.expires < Date.now() || item.owner.id === ctx.user.id) pending.delete(key);
    if (pending.size >= 500) throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
    const state = randomBytes(32).toString("base64url"); pending.set(state, { owner: ctx.user, expires: Date.now() + 600000 });
    ctx.res.cookie(cookieName, state, { ...localCookieOptions(ctx.req), maxAge: 600000, httpOnly: true, sameSite: "lax" });
    const params = new URLSearchParams({ client_id: process.env.HUBSPOT_CLIENT_ID!.trim(), redirect_uri: callbackUrl(), scope: process.env.HUBSPOT_OAUTH_SCOPES?.trim() || "oauth crm.objects.contacts.read crm.objects.contacts.write", state });
    if (process.env.HUBSPOT_OAUTH_OPTIONAL_SCOPES?.trim()) params.set("optional_scope", process.env.HUBSPOT_OAUTH_OPTIONAL_SCOPES.trim());
    return { url: `https://app.hubspot.com/oauth/authorize?${params}` };
  })),
  disconnect: protectedProcedure.mutation(({ ctx }) => hubspotExclusive(ctx.user.id, async () => {
    for (const [key, item] of pending) if (item.owner.id === ctx.user.id) pending.delete(key);
    // A persistent tombstone prevents silent fallback to the server's private app.
    await save(ctx.user.id, { generation: randomUUID(), mode: "disconnected" });
    return { disconnected: true, message: "Disconnected locally. To revoke the app's authorization too, remove it in HubSpot Connected Apps." };
  })),
  useServerConnection: protectedProcedure.mutation(({ ctx }) => hubspotExclusive(ctx.user.id, async () => {
    if (ctx.user.role !== "admin" || !ENV.hubspotToken) throw new TRPCError({ code: "FORBIDDEN" });
    await save(ctx.user.id, { generation: randomUUID(), mode: "server" }); return { connected: true };
  })),
};
export function registerHubspotCallback(app: Express) {
  app.get("/api/hubspot/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const state = typeof req.query.state === "string" ? req.query.state : "", cookie = parse(req.headers.cookie ?? "")[cookieName] ?? "";
    const item = pending.get(state);
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || state.length !== cookie.length || !item || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) { res.status(400).send("HubSpot connection could not be verified. Return to the CRM and connect again."); return; }
    res.clearCookie(cookieName, localCookieOptions(req));
    try {
      await hubspotExclusive(item.owner.id, async () => {
        const owner = await authenticateRequest(req);
        if (!owner || owner.id !== item.owner.id || owner.sessionVersion !== item.owner.sessionVersion || pending.get(state) !== item || item.expires < Date.now()) throw new Error("Expired state");
        const code = typeof req.query.code === "string" ? req.query.code : "";
        if (!code || code.length > 4096 || req.query.error) throw new Error("Declined");
        pending.delete(state);
        const token = await exchange({ grant_type: "authorization_code", code, redirect_uri: callbackUrl() });
        const current = await authenticateRequest(req);
        if (!current || current.id !== owner.id || current.sessionVersion !== owner.sessionVersion || item.expires < Date.now()) throw new Error("Session changed");
        await save(owner.id, { mode: "oauth", generation: randomUUID(), accessToken: token.access_token, refreshToken: token.refresh_token, expires: Date.now() + token.expires_in * 1000, hubId: token.hub_id });
      });
      res.redirect(303, `${new URL(ENV.appOrigin).origin}/?tab=hubspot&hubspot=connected`);
    } catch { res.redirect(303, `${new URL(ENV.appOrigin).origin}/?tab=hubspot&hubspot=failed`); }
    finally { pending.delete(state); }
  });
}
