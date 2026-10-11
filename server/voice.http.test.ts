import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { COOKIE_NAME } from "../shared/const";
import { createApp } from "./_core/index";
import { createLocalSession } from "./_core/localAuth";
import { ENV } from "./_core/env";
import { getUserByOpenId, getDashboard } from "./db";
import { prepareVoiceTurn } from "./voiceAssistant";
import { transcribeAudio } from "./_core/voiceTranscription";

vi.mock("./db", async importOriginal => ({ ...await importOriginal<typeof import("./db")>(), getUserByOpenId: vi.fn(), getDashboard: vi.fn() }));
vi.mock("./voiceAssistant", () => ({ prepareVoiceTurn: vi.fn() }));
vi.mock("./_core/voiceTranscription", () => ({ transcribeAudio: vi.fn() }));
vi.mock("./metrics", () => ({ recordMetric: vi.fn(async () => {}), getMetricSummary: vi.fn() }));
vi.mock("./_core/tts", async importOriginal => ({ ...await importOriginal<typeof import("./_core/tts")>(), synthesize: vi.fn(async (text: string) => ({ audioBuffer: Buffer.from("RIFFtestWAVE"), text, durationMs: 1 })) }));
vi.mock("./_core/health", () => ({ checkReadiness: vi.fn(async () => ({ ready: true })), poolStatus: () => ({}) }));

let server: Server, origin: string, cookie: string;
const original = { appOrigin: ENV.appOrigin, port: ENV.port, host: ENV.host, cookieSecret: ENV.cookieSecret, isProduction: ENV.isProduction };
const user = { id: 7, openId: "local_http_test", role: "admin", name: "HTTP test", sessionVersion: 3, passwordHash: "never-expose-this-hash" };
beforeAll(async () => {
  Object.assign(ENV, { cookieSecret: "a-secure-test-only-jwt-secret-48-characters-long", host: "127.0.0.1", isProduction: false });
  const app = createApp();
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing listener");
  origin = `http://127.0.0.1:${address.port}`; ENV.port = address.port; ENV.appOrigin = origin;
  cookie = `${COOKIE_NAME}=${await createLocalSession(user.openId, user.name, user.sessionVersion)}`;
});
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(getUserByOpenId).mockResolvedValue({ ...user } as never);
  vi.mocked(prepareVoiceTurn).mockResolvedValue({ text: "Actual CRM note: budget approved.", sources: [{ kind: "interaction", id: "30", label: "Local note", provider: "local" }], choices: [], warnings: [], sessionId: null, proposal: null, llmMs: 12, retrievalMs: 2, inputTokens: 5, outputTokens: 6, loadMs: 0 });
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); Object.assign(ENV, original); });
describe("authenticated voice transport", () => {
  it("finalizes each live segment once and rejects access by another user", async () => {
    expect((await fetch(`${origin}/api/voice/live/start`, { method: "POST" })).status).toBe(401);
    const started = await fetch(`${origin}/api/voice/live/start`, { method: "POST", headers: { Cookie: cookie } });
    const { id } = await started.json();
    vi.mocked(transcribeAudio).mockResolvedValue({ text: "Find Maya", language: "en", duration: 1, segments: [], task: "transcribe" });
    const send = () => fetch(`${origin}/api/voice/preview`, { method: "POST", headers: {
      Cookie: cookie, "Content-Type": "audio/wav", "X-Live-Id": id, "X-Live-Sequence": "0", "X-Live-Final": "1",
    }, body: Buffer.alloc(46) });
    vi.mocked(getUserByOpenId).mockResolvedValue({ ...user, id: 8 } as never);
    expect((await send()).status).toBe(409);
    expect(transcribeAudio).not.toHaveBeenCalled();
    vi.mocked(getUserByOpenId).mockResolvedValue({ ...user } as never);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });
  it("does not leak database errors or stack traces through tRPC", async () => {
    vi.mocked(getDashboard).mockRejectedValueOnce(new Error("SQL SELECT private_customer_email FROM contacts; secret-db-host"));
    const response = await fetch(`${origin}/api/trpc/dashboard.get`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("The request could not complete");
    expect(body).not.toContain("private_customer_email"); expect(body).not.toContain("secret-db-host"); expect(body).not.toContain('"stack"');
  });
  it("does not expose raw driver error messages in streamed voice responses", async () => {
    vi.mocked(prepareVoiceTurn).mockRejectedValueOnce(Object.assign(new Error("SQL contains private CRM values"), { code: "ER_BAD_FIELD_ERROR" }));
    const response = await fetch(`${origin}/api/voice/respond`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Read my notes" }) });
    const body = await response.text();
    expect(body).toContain('"type":"error"'); expect(body).not.toContain("private CRM values");
  });
  it("protects recordings and grounded responses before reading data", async () => {
    expect((await fetch(`${origin}/uploads/example.wav`)).status).toBe(401);
    expect((await fetch(`${origin}/api/voice/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Read my notes" }) })).status).toBe(401);
    expect(prepareVoiceTurn).not.toHaveBeenCalled();
  });
  it("rejects cross-origin browser writes", async () => {
    const response = await fetch(`${origin}/api/voice/respond`, { method: "POST", headers: { Cookie: cookie, Origin: "https://untrusted.example", "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Read my notes" }) });
    expect(response.status).toBe(403); expect(prepareVoiceTurn).not.toHaveBeenCalled();
  });
  it("does not accept a token after the account's sessions were revoked", async () => {
    vi.mocked(getUserByOpenId).mockResolvedValue({ ...user, sessionVersion: 4 } as never);
    expect((await fetch(`${origin}/api/voice/respond`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Read my notes" }) })).status).toBe(401);
  });
  it("streams grounded text and owner-restricted binary audio without base64 or prompts in URLs", async () => {
    const response = await fetch(`${origin}/api/voice/respond`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "What did I last discuss with Maya?", speak: true }) });
    expect(response.status).toBe(200);
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(events.find(event => event.type === "response").text).toContain("Actual CRM note");
    const audio = events.find(event => event.type === "audio"); expect(audio.url).toMatch(/^\/api\/voice\/audio\//); expect(audio.wav).toBeUndefined();
    expect((await fetch(origin + audio.url)).status).toBe(401);
    vi.mocked(getUserByOpenId).mockResolvedValue({ ...user, id: 8 } as never);
    expect((await fetch(origin + audio.url, { headers: { Cookie: cookie } })).status).toBe(404);
    vi.mocked(getUserByOpenId).mockResolvedValue({ ...user } as never);
    const playback = await fetch(origin + audio.url, { headers: { Cookie: cookie } });
    expect(playback.headers.get("content-type")).toContain("audio/wav"); expect(await playback.text()).toBe("RIFFtestWAVE");
    expect((await fetch(origin + audio.url, { headers: { Cookie: cookie } })).status).toBe(404);
  });
  it("does not expose stored password hashes through auth.me", async () => {
    const response = await fetch(`${origin}/api/trpc/auth.me`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200); const text = await response.text(); expect(text).not.toContain("never-expose-this-hash"); expect(text).not.toContain("sessionVersion");
  });
});
