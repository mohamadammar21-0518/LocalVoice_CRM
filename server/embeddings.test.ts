import { afterEach, expect, it, vi } from "vitest";
vi.mock("./db", () => ({ getDb: vi.fn(async () => null), contacts: {}, searchContacts: vi.fn() }));
import { semanticSearchContacts } from "./_core/embeddings";

afterEach(() => vi.unstubAllGlobals());

it("sets a deadline on embedding requests so callers can fall back", async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    throw new Error("service unavailable");
  });
  vi.stubGlobal("fetch", fetch);
  await expect(semanticSearchContacts(1, "creative director")).rejects.toThrow("service unavailable");
});

it("rejects malformed vectors rather than returning invalid similarity scores", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ embedding: [1, "invalid"] })));
  await expect(semanticSearchContacts(2, "Maya")).rejects.toThrow("Invalid embedding response");
});
