import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareVoiceTurn } from "./voiceAssistant";
import { invokeLLM } from "./_core/llm";
import { getContact, getInteractions, getTasks, getDashboard, searchContacts } from "./db";
import { getAssociatedRecords } from "./hubspot";
import { resolveProposalContacts, storeProposal } from "./voiceActions";

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./db", () => ({ getContact: vi.fn(), getInteractions: vi.fn(), getTasks: vi.fn(), getDashboard: vi.fn(), searchContacts: vi.fn(), requireDb: vi.fn(), voiceSessions: {} }));
vi.mock("./hubspot", () => ({ getAssociatedRecords: vi.fn(), getHubSpotObject: vi.fn(), plainText: (text: string) => text, isHubSpotConfigured: () => true }));
vi.mock("./voiceActions", () => ({ resolveProposalContacts: vi.fn(), storeProposal: vi.fn() }));
const contact = { id: 10, userId: 7, firstName: "Maya", lastName: "Chen", company: "Northstar", email: "maya@example.com", hubspotId: "42" };
const input = { prompt: "What did I last discuss with Maya Chen?", source: "local" as const, timezone: "Asia/Kuala_Lumpur" };
function model(kind: string, additions = {}) {
  vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ kind, contactQuery: "Maya Chen", taskFilter: "all", limit: 1, actions: [], ...additions }) } }], timing: { totalMs: 100, loadMs: 0 }, usage: { prompt_tokens: 5, completion_tokens: 8 } } as never);
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(searchContacts).mockResolvedValue([contact] as never); vi.mocked(getContact).mockResolvedValue(contact as never); vi.mocked(getInteractions).mockResolvedValue([{ id: 30, body: "Actual CRM note: the budget was approved", kind: "meeting", occurredAt: new Date("2026-10-06T03:00:00Z"), hubspotId: null }] as never); });
describe("CRM-grounded voice answers", () => {
  it("answers from owner-scoped interaction records, not model-generated facts", async () => {
    model("history"); const turn = await prepareVoiceTurn({ id: 7, role: "user" }, input);
    expect(getInteractions).toHaveBeenCalledWith(7, 10, 1); expect(turn.text).toContain("Actual CRM note: the budget was approved");
    expect(turn.sources).toContainEqual(expect.objectContaining({ kind: "interaction", id: "30", provider: "local" }));
    expect(getAssociatedRecords).not.toHaveBeenCalled(); expect(storeProposal).not.toHaveBeenCalled();
  });
  it("asks for a specific contact when exact names are duplicated", async () => {
    model("history"); vi.mocked(searchContacts).mockResolvedValue([contact, { ...contact, id: 11, company: "Other company" }] as never);
    const turn = await prepareVoiceTurn({ id: 7, role: "user" }, input);
    expect(turn.choices).toHaveLength(2); expect(turn.text).toContain("Choose"); expect(getInteractions).not.toHaveBeenCalled();
  });
  it("never queries HubSpot with a regular user's shared-server credential", async () => {
    await expect(prepareVoiceTurn({ id: 7, role: "user" }, { ...input, source: "both" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(invokeLLM).not.toHaveBeenCalled(); expect(getAssociatedRecords).not.toHaveBeenCalled();
  });
  it("reads live HubSpot notes for the selected linked contact and marks the source", async () => {
    model("history"); vi.mocked(getAssociatedRecords).mockResolvedValue({ results: [{ id: "55", properties: { hs_note_body: "Live contract approval", hs_timestamp: "2026-10-07T03:00:00Z" } }], truncated: false });
    const turn = await prepareVoiceTurn({ id: 7, role: "admin" }, { ...input, source: "both" });
    expect(getAssociatedRecords).toHaveBeenCalledWith("42", "notes", undefined); expect(turn.text).toContain("Live contract approval"); expect(turn.sources[0].provider).toBe("hubspot");
  });
  it("preserves local results and reports a live-provider outage", async () => {
    model("history"); vi.mocked(getAssociatedRecords).mockRejectedValue(new Error("Unavailable"));
    const turn = await prepareVoiceTurn({ id: 7, role: "admin" }, { ...input, source: "both" });
    expect(turn.text).toContain("Actual CRM note"); expect(turn.warnings).toHaveLength(1);
  });
  it("prepares changes without executing a CRM mutation or inventing a missing date", async () => {
    model("propose", { actions: [{ type: "create_follow_up", contactName: "Maya Chen", note: null, taskTitle: "Call", dueDate: "2026-10-20", dateExpression: "sometime soon", reason: null }] });
    vi.mocked(resolveProposalContacts).mockImplementation(async (_id, proposal) => ({ ...proposal, actions: proposal.actions.map(action => ({ ...action, candidates: [] })) }));
    vi.mocked(storeProposal).mockImplementation(async (_id, _session, proposal) => ({ sessionId: 99, proposal: { ...proposal, version: 1 } }));
    const turn = await prepareVoiceTurn({ id: 7, role: "user" }, { ...input, prompt: "Prepare a follow-up for Maya sometime soon" });
    expect(turn.proposal?.actions[0].dueDate).toBeNull(); expect(turn.text).toContain("for review"); expect(turn.text).not.toContain("Saved");
  });
});
