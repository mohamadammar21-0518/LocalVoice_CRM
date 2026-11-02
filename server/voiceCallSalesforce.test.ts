import { beforeEach, describe, expect, it, vi } from "vitest";
const { llm, api } = vi.hoisted(() => ({ llm: vi.fn(), api: { objects: vi.fn(), describeObject: vi.fn(), listRecords: vi.fn(), getRecord: vi.fn(), prepareChange: vi.fn(), confirmChange: vi.fn(), rejectChange: vi.fn() } }));
vi.mock("./_core/llm", () => ({ invokeLLM: llm }));
vi.mock("./salesforce", () => ({ salesforceRouter: { createCaller: () => api } }));
import { prepareSalesforceCall } from "./voiceCallSalesforce";
import type { TrpcContext } from "./_core/context";
const ctx = { user: { id: 1, role: "user", sessionVersion: 0 } } as TrpcContext;
const response = (operation: string, fields = {}) => llm.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ object: "Contact", operation, search: "Maya", fields, readFields: ["Name"], question: null }) } }] });
beforeEach(() => {
  vi.clearAllMocks();
  api.objects.mockResolvedValue(["Contact", "Opportunity", "Task", "Account"].map(name => ({ name })));
  api.describeObject.mockImplementation(async ({ object }) => ({ label: object, fields: [{ name: "Name", label: "Name", type: "string", createable: true, updateable: true }] }));
  api.listRecords.mockResolvedValue({ records: [{ Id: "003000000000001AAA", label: "Maya" }], truncated: false });
  api.getRecord.mockResolvedValue({ record: { Name: "Maya" } });
  api.prepareChange.mockResolvedValue({ token: "review-token", object: "Contact", label: "Contact", id: "003000000000001AAA", operation: "update" });
});
describe("Salesforce call planner", () => {
  it("reads without preparing or executing writes", async () => {
    response("read");
    const result = await prepareSalesforceCall(ctx, "Read contacts Maya", {}, new AbortController().signal);
    expect(result.text).toContain("Maya"); expect(api.prepareChange).not.toHaveBeenCalled(); expect(api.confirmChange).not.toHaveBeenCalled();
  });
  it("maps deals to Opportunities and asks when multiple records match", async () => {
    response("update", { Name: "New name" }); api.listRecords.mockResolvedValue({ records: [{ Id: "one", label: "A" }, { Id: "two", label: "B" }], truncated: false });
    const result = await prepareSalesforceCall(ctx, "Edit deals Maya", {}, new AbortController().signal);
    expect(api.describeObject).toHaveBeenCalledWith({ object: "Opportunity" }); expect(result.text).toContain("Number 1"); expect(api.prepareChange).not.toHaveBeenCalled();
  });
  it("returns a review closure, never saves during planning, and supports cancellation", async () => {
    response("update", { Name: "New name" });
    const result = await prepareSalesforceCall(ctx, "Edit contact Maya", {}, new AbortController().signal);
    expect(api.prepareChange).toHaveBeenCalled(); expect(api.confirmChange).not.toHaveBeenCalled();
    await result.change!.reject(); expect(api.rejectChange).toHaveBeenCalledWith({ token: "review-token" });
  });
  it("passes the deletion confirmation only when its approval closure is executed", async () => {
    response("delete"); api.prepareChange.mockResolvedValue({ token: "review-token", label: "Contact", operation: "delete", id: "003000000000001AAA" });
    const result = await prepareSalesforceCall(ctx, "Delete contact Maya", {}, new AbortController().signal);
    expect(result.change?.delete).toBe(true); expect(api.confirmChange).not.toHaveBeenCalled();
    await result.change!.execute(); expect(api.confirmChange).toHaveBeenCalledWith({ token: "review-token", deleteText: "DELETE" });
  });
});
