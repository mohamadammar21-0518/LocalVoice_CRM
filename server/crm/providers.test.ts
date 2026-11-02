import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteProvider, remoteRequest, connectionStatus } from "./providers";
import { parseTwentyMetadataPage, readTwentyMetadata } from "./twentyMetadata";
import { newWorkspace } from "./store";
import { crmTemplates } from "../../shared/crm";
import type { TrpcContext } from "../_core/context";
const context = { user: { id: 1, sessionVersion: 0 } } as TrpcContext;
const w = newWorkspace(crmTemplates[0].blueprint);
w.provider = "twenty";
w.mappings = {
  companies: {
    remoteObject: "companies",
    fields: { name: "name", industry: "industry" },
  },
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.stubEnv("TWENTY_WORKSPACE_ID", w.id);
  vi.stubEnv("TWENTY_API_URL", "https://crm.example.test");
  vi.stubEnv("TWENTY_API_KEY", "fake-test-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const metadata = {
  id: "meta1",
  nameSingular: "company",
  namePlural: "companies",
  labelPlural: "Companies",
  fields: [],
};
describe("Twenty contract", () => {
  it("keeps placeholder connections inactive and never sends placeholder tokens", async () => {
    vi.stubEnv("TWENTY_API_KEY", "REPLACE_WITH_TWENTY_API_KEY");
    expect(connectionStatus(w).find(c => c.id === "twenty")?.configured).toBe(false);
    await expect(remoteRequest(w, "/rest/companies")).rejects.toThrow(/credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("accepts both published metadata envelopes", () => {
    expect(parseTwentyMetadataPage({ data: [metadata] }).objects).toHaveLength(
      1
    );
    expect(
      parseTwentyMetadataPage({ data: { objects: [metadata] } }).objects
    ).toHaveLength(1);
  });
  it("follows metadata pagination instead of omitting objects", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          data: [metadata],
          pageInfo: { hasNextPage: true, endCursor: "cursor" },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ ...metadata, id: "meta2" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        })
      );
    expect(await readTwentyMetadata(w)).toHaveLength(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "starting_after=cursor"
    );
  });
  it("normalizes read envelopes and sends bearer authorization only to configured origin", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: { companies: [{ id: "r", name: "Acme", industry: "Tech" }] },
      })
    );
    const result = await remoteProvider(w, context).list("companies", "Acme");
    expect(result.records[0].values).toEqual({
      name: "Acme",
      industry: "Tech",
    });
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer fake-test-key"
    );
  });
  it("rejects credentials assigned to another workspace", async () => {
    vi.stubEnv("TWENTY_WORKSPACE_ID", "another-id");
    await expect(remoteRequest(w, "/rest/companies")).rejects.toThrow(
      /not assigned/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects cleartext nonlocal origins", async () => {
    vi.stubEnv("TWENTY_API_URL", "http://crm.example.test");
    await expect(remoteRequest(w, "/rest/companies")).rejects.toThrow(/HTTPS/);
  });
  it("does not retry non-idempotent requests", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));
    await expect(
      remoteProvider(w, context).execute({
        operation: "create",
        object: "companies",
        values: { name: "Acme" },
      })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("maps fields for a Twenty create and validates returned receipt", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ data: { createCompany: { id: "new-record" } } })
    );
    expect(
      (
        await remoteProvider(w, context).execute({
          operation: "create",
          object: "companies",
          values: { name: "Acme" },
        })
      ).id
    ).toBe("new-record");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: "Acme",
    });
  });
});
