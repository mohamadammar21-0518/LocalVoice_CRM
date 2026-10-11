import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { salesforceRouter, registerSalesforceCallback } from "./salesforce";
import { SalesforceConnectionStore, salesforceStore } from "./salesforceStore";
import { authenticateRequest } from "./_core/localAuth";
import { ENV } from "./_core/env";

vi.mock("./salesforceStore", async importOriginal => ({
  ...(await importOriginal<typeof import("./salesforceStore")>()),
  salesforceStore: vi.fn(),
}));
vi.mock("./_core/localAuth", () => ({
  authenticateRequest: vi.fn(),
  localCookieOptions: () => ({ httpOnly: true }),
}));
vi.mock("./metrics", () => ({ recordMetric: vi.fn() }));
const instance = "https://demo.my.salesforce.com";
const owner = { id: 7, sessionVersion: 2 };
const connection = {
  version: 2,
  accessToken: "access-old",
  refreshToken: "refresh-old",
  instance,
};
const contact = {
  Id: "003000000000001AAA",
  Name: "Maya Chen",
  Email: null,
  Account: null,
};
const result = () =>
  Response.json({ records: [contact], done: true, totalSize: 1 });
let store: SalesforceConnectionStore;
const context = () =>
  ({
    user: owner,
    req: { get: () => new URL(ENV.appOrigin).host },
    res: { cookie: vi.fn() },
  }) as unknown as TrpcContext;
beforeEach(async () => {
  vi.stubEnv("SALESFORCE_LOGIN_URL", instance);
  vi.stubEnv("SALESFORCE_CLIENT_ID", "test-client");
  store = new SalesforceConnectionStore({
    directory: "unused",
    binding: "test",
    instance,
  });
  vi.mocked(salesforceStore).mockReturnValue(store);
  vi.mocked(authenticateRequest).mockResolvedValue(owner as never);
  await store.save(owner, connection);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("Salesforce owner and authorization lifecycle", () => {
  it("keeps connection status free of tokens and isolates local owners", async () => {
    const status = await salesforceRouter.createCaller(context()).status();
    expect(status.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain("access-old");
    const another = {
      ...context(),
      user: { ...owner, id: 8 },
    } as unknown as TrpcContext;
    expect(
      (await salesforceRouter.createCaller(another).status()).connected
    ).toBe(false);
  });
  it("refreshes once for concurrent reads and saves rotated refresh credentials", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/token"))
        return Response.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          instance_url: instance,
        });
      return (init.headers as Record<string, string>).Authorization ===
        "Bearer access-old"
        ? new Response(null, { status: 401 })
        : result();
    });
    vi.stubGlobal("fetch", fetchMock);
    const caller = salesforceRouter.createCaller(context());
    await Promise.all([
      caller.findContact({ request: "Maya" }),
      caller.findContact({ request: "Maya" }),
    ]);
    expect(
      fetchMock.mock.calls.filter(([url]) => url.endsWith("/token"))
    ).toHaveLength(1);
    expect(await store.load(owner)).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
  });
  it("marks revoked authorization disconnected instead of retrying indefinitely", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(
          Response.json(
            {
              error: "invalid_grant",
              error_description: "provider-private-detail",
            },
            { status: 400 }
          )
        )
    );
    const caller = salesforceRouter.createCaller(context());
    await expect(caller.findContact({ request: "Maya" })).rejects.toThrow(
      "authorization expired or was revoked"
    );
    expect((await caller.status()).connected).toBe(false);
  });
  it("escapes SOQL quote and wildcard characters in names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(result());
    vi.stubGlobal("fetch", fetchMock);
    await salesforceRouter
      .createCaller(context())
      .findContact({ request: "Find O'Neil%_" });
    const soql = new URL(fetchMock.mock.calls[0][0]).searchParams.get("q");
    expect(soql).toContain("O\\'Neil\\%\\_");
  });
  it("does not let an in-flight OAuth callback restore a disconnected connection", async () => {
    const ctx = context(),
      caller = salesforceRouter.createCaller(ctx);
    const authorization = new URL((await caller.connect()).url),
      state = authorization.searchParams.get("state")!;
    let callback!: (req: unknown, res: unknown) => Promise<void>;
    registerSalesforceCallback({
      get: (_path: string, handler: typeof callback) => {
        callback = handler;
      },
    } as never);
    let started!: () => void, finish!: (value: Response) => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    const exchange = new Promise<Response>(resolve => {
      finish = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/token")) {
          started();
          return exchange;
        }
        return new Response(null, { status: 200 });
      })
    );
    const res = { setHeader: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn() };
    const completing = callback(
      {
        query: { state, code: "test-code" },
        headers: { cookie: `localvoice_salesforce_state=${state}` },
      },
      res
    );
    await ready;
    const disconnecting = caller.disconnect();
    // Let the tRPC disconnect handler invalidate pending authorization before releasing the exchange.
    await new Promise(resolve => setImmediate(resolve));
    finish(
      Response.json({
        access_token: "late-token",
        refresh_token: "late-refresh",
        instance_url: instance,
      })
    );
    await Promise.all([completing, disconnecting]);
    expect(await store.load(owner)).toBeUndefined();
    expect(res.redirect).toHaveBeenCalledWith(
      303,
      expect.stringContaining("salesforce=failed")
    );
  });
});
