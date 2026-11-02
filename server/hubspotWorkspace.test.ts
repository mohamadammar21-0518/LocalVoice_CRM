import { beforeEach, describe, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./hubspot", () => ({ hubspotRequest: request, isHubSpotConfigured: () => true, HubSpotRequestError: class extends Error { status = 403; } }));
import { hsList, hsGet, hsDraft, hsConfirm, hsReject } from "./hubspotWorkspace";
import type { TrpcContext } from "./_core/context";
const ctx = (id = 1, role = "admin") => ({ user: { id, role, sessionVersion: 0 } }) as TrpcContext;
const record = { id: "12", properties: { firstname: "Maya", lastname: "Chen", email: "maya@example.test", custom_data: "Custom value" }, updatedAt: "2026-10-01" };
beforeEach(() => {
  request.mockReset().mockImplementation(async (url: string) => {
    if (url.includes("/properties/")) return { results: ["firstname", "lastname", "email", "custom_data"].map(name => ({ name, label: name, type: "string", options: [] })) };
    if (url.includes("/batch/read")) return { results: [record] };
    if (url.includes("?")) return { results: [record], paging: { next: { after: "51" } } };
    return {};
  });
});
describe("HubSpot workspace", () => {
  it("preserves paging and fetches discovered custom properties for full record details", async () => {
    expect((await hsList({ object: "contacts", after: "50" })).after).toBe("51");
    expect(request.mock.calls.some(([url]) => url.includes("after=50"))).toBe(true);
    expect((await hsGet("contacts", "12")).properties.custom_data).toBe("Custom value");
    const body = request.mock.calls.find(([url]) => url.includes("batch/read"))![1].body;
    expect(JSON.parse(body).properties).toContain("custom_data");
  });
  it("prepares without writing, binds owner, and prevents duplicate creates", async () => {
    const draft = await hsDraft(ctx(), { object: "contacts", operation: "create", values: { firstname: "Test" } });
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await expect(hsConfirm(ctx(2), draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await hsConfirm(ctx(), draft.id); await hsConfirm(ctx(), draft.id);
    expect(request.mock.calls.filter(([url, init]) => url === "/crm/v3/objects/contacts" && init?.method === "POST")).toHaveLength(1);
  });
  it("requires explicit DELETE and refuses changed records", async () => {
    const draft = await hsDraft(ctx(), { object: "contacts", operation: "delete", recordId: "12", values: {} });
    await expect(hsConfirm(ctx(), draft.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    request.mockResolvedValueOnce({ results: [{ ...record, updatedAt: "2026-10-02" }] });
    await expect(hsConfirm(ctx(), draft.id, "DELETE")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it("keeps cancelled changes cancelled and denies non-admin drafts", async () => {
    await expect(hsDraft(ctx(1, "user"), { object: "contacts", operation: "create", values: { firstname: "No" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const draft = await hsDraft(ctx(), { object: "contacts", operation: "update", recordId: "12", values: { firstname: "New" } });
    hsReject(ctx(), draft.id);
    await expect(hsConfirm(ctx(), draft.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("never automatically retries a write with an uncertain outcome", async () => {
    const draft = await hsDraft(ctx(), { object: "contacts", operation: "create", values: { firstname: "Test" } });
    request.mockRejectedValueOnce(new Error("Connection lost after sending"));
    await expect(hsConfirm(ctx(), draft.id)).rejects.toThrow();
    const count = request.mock.calls.length;
    await expect(hsConfirm(ctx(), draft.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(request.mock.calls.length).toBe(count);
  });
});
