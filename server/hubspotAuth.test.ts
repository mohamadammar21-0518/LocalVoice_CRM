import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("./_core/localAuth", () => ({ authenticateRequest: authenticate, localCookieOptions: () => ({ httpOnly: true, sameSite: "lax", path: "/" }) }));
vi.mock("./_core/env", () => ({ ENV: { appOrigin: "https://localhost:3100", hubspotToken: "shared-admin-token", hubspotTimeoutMs: 1000 } }));
import { router } from "./_core/trpc";
import { hubspotConnectionProcedures, registerHubspotCallback, withHubspot, hubspotIdentity } from "./hubspotAuth";
import { hubspotRequest } from "./hubspot";
import type { TrpcContext } from "./_core/context";
import type { Express } from "express";

let userId = 700;
function fixture(role = "user") {
  const user = { id: ++userId, role, sessionVersion: 0 };
  const res = { cookie: vi.fn(), clearCookie: vi.fn(), setHeader: vi.fn(), status: vi.fn().mockReturnThis(), send: vi.fn(), redirect: vi.fn() };
  const ctx = { user, req: {}, res } as unknown as TrpcContext;
  const api = router(hubspotConnectionProcedures).createCaller(ctx);
  let callback: (req: any, res: any) => Promise<void>;
  registerHubspotCallback({ get: (_: string, fn: typeof callback) => { callback = fn; } } as unknown as Express);
  return { user, res, api, finish: async (state: string, cookie = state) => callback({ query: { state, code: "test-code" }, headers: { cookie: `localvoice_hubspot_state=${cookie}` } }, res) };
}
beforeEach(() => {
  vi.stubEnv("HUBSPOT_CLIENT_ID", "test-client"); vi.stubEnv("HUBSPOT_CLIENT_SECRET", "secret-not-for-client");
  vi.stubEnv("HUBSPOT_TOKEN_ENCRYPTION_KEY", ""); vi.stubEnv("SALESFORCE_TOKEN_ENCRYPTION_KEY", "");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "oauth-account-token", refresh_token: "refresh-token", expires_in: 1800, hub_id: 42 }), { status: 200 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("HubSpot account login", () => {
  it("uses a state-bound login URL without exposing the client secret", async () => {
    const f = fixture(); const { url } = await f.api.connect(); const parsed = new URL(url);
    expect(parsed.origin).toBe("https://app.hubspot.com"); expect(parsed.searchParams.get("state")).toHaveLength(43);
    expect(url).not.toContain("secret-not-for-client"); expect(f.res.cookie).toHaveBeenCalled();
  });
  it("rejects callback cookie and owner-session mismatch without exchanging tokens", async () => {
    const f = fixture(); const { url } = await f.api.connect(); const state = new URL(url).searchParams.get("state")!;
    await f.finish(state, "wrong"); expect(f.res.status).toHaveBeenCalledWith(400);
    authenticate.mockResolvedValue({ ...f.user, sessionVersion: 1 }); await f.finish(state);
    expect(fetch).not.toHaveBeenCalled(); expect(f.res.redirect).toHaveBeenCalledWith(303, expect.stringContaining("hubspot=failed"));
  });
  it("isolates OAuth credentials and keeps disconnect from falling back to shared credentials", async () => {
    const f = fixture("admin"); const { url } = await f.api.connect(); authenticate.mockResolvedValue(f.user);
    await f.finish(new URL(url).searchParams.get("state")!);
    expect((await f.api.connection()).hubId).toBe(42);
    await withHubspot(f.user, () => hubspotRequest("/crm/v3/objects/contacts"));
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: "Bearer oauth-account-token" });
    const before = await withHubspot(f.user, async () => hubspotIdentity());
    await f.api.disconnect();
    await expect(withHubspot(f.user, () => hubspotRequest("/crm/v3/objects/contacts"))).rejects.toThrow();
    expect(await withHubspot(f.user, async () => hubspotIdentity())).not.toBe(before);
    const other = fixture(); await expect(withHubspot(other.user, () => hubspotRequest("/crm/v3/objects/contacts"))).rejects.toThrow();
  });
  it("invalidates pending OAuth callbacks when disconnected", async () => {
    const f = fixture(); const { url } = await f.api.connect(); authenticate.mockResolvedValue(f.user);
    await f.api.disconnect(); await f.finish(new URL(url).searchParams.get("state")!);
    expect(fetch).not.toHaveBeenCalled(); expect(f.res.status).toHaveBeenCalledWith(400);
  });
});
