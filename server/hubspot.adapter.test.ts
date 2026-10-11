import { afterEach, describe, expect, it, vi } from "vitest";
import { hubspot, listHubSpotPage, HubSpotConfigurationError, HubSpotRequestError, getAssociatedRecords } from "./hubspot";
const previous = process.env.HUBSPOT_ACCESS_TOKEN;
afterEach(() => { vi.unstubAllGlobals(); if (previous === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN; else process.env.HUBSPOT_ACCESS_TOKEN = previous; });
describe("HubSpot adapter", () => {
  it("makes no network request without a token", async () => {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(hubspot.status().configured).toBe(false);
    await expect(hubspot.listContacts()).rejects.toBeInstanceOf(HubSpotConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("paginates contacts and preserves a next-page cursor", async () => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-only-token";
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: "42", properties: { firstname: "Maya" } }], paging: { next: { after: "99" } } }), { headers: { "Content-Type": "application/json" } })); vi.stubGlobal("fetch", fetch);
    const page = await listHubSpotPage("contacts", "10");
    expect(page.after).toBe("99"); expect(fetch.mock.calls[0][0]).toContain("after=10");
  });
  it("does not retry a timed-out remote create", async () => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-only-token";
    const fetch = vi.fn(async () => { throw new Error("timeout"); }); vi.stubGlobal("fetch", fetch);
    await expect(hubspot.createContact({ firstname: "Maya" })).rejects.toMatchObject({ status: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("builds the actual association request and keeps credentials out of errors", async () => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-only-token";
    const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({ id: "123", properties: {} }), { headers: { "Content-Type": "application/json" } })); vi.stubGlobal("fetch", fetch);
    await hubspot.createNote("42", "Discuss pricing");
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body.associations[0].to.id).toBe("42"); expect(body.associations[0].types[0].associationTypeId).toBe(202);
    expect(body.properties.hs_note_body).toBe("Discuss pricing");
    fetch.mockImplementation(async () => new Response(JSON.stringify({ message: "secret account detail" }), { status: 403 }));
    await expect(hubspot.listContacts()).rejects.toThrow("HubSpot returned HTTP 403");
  });
  it("retrieves live notes only for the selected contact association", async () => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-only-token";
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ toObjectId: 55 }] }))).mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "55", properties: { hs_note_body: "Agreed budget" } }] }))); vi.stubGlobal("fetch", fetch);
    const notes = await getAssociatedRecords("42", "notes");
    expect(fetch.mock.calls[0][0]).toContain("contacts/42/associations/notes");
    expect(JSON.parse(fetch.mock.calls[1][1].body).inputs).toEqual([{ id: "55" }]);
    expect(notes.results[0].properties.hs_note_body).toBe("Agreed budget");
  });
});
