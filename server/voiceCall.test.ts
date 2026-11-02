import { describe, expect, it, vi } from "vitest";
import { VoiceCalls } from "./voiceCall";
import { callControl } from "../shared/voiceCall";
import type { TrpcContext } from "./_core/context";
import type { prepareVoiceTurn } from "./voiceAssistant";
import type { confirmVoiceProposal, rejectVoiceProposal } from "./voiceActions";
import { prepareHubspotCall } from "./voiceCallHubspot";
import { answerGeneralCallQuestion } from "./voiceCallGeneral";

vi.mock("./voiceCallHubspot", () => ({ prepareHubspotCall: vi.fn() }));
vi.mock("./voiceCallGeneral", async importOriginal => ({
  ...(await importOriginal<typeof import("./voiceCallGeneral")>()),
  answerGeneralCallQuestion: vi.fn().mockResolvedValue("Blue light scatters more strongly."),
}));

const ctx = (id = 1, sessionVersion = 0) => ({ user: { id, sessionVersion, role: "user" } }) as TrpcContext;
function fixture() {
  const proposal = { actions: [{ type: "add_note" as const, contactId: 2, contactName: "Maya Chen", note: "Discuss pricing", candidates: [] }], version: 1, timezone: "Asia/Kuala_Lumpur" };
  const prepare = vi.fn<typeof prepareVoiceTurn>().mockResolvedValue({ text: "Prepared", choices: [], proposal, sessionId: 10, sources: [], warnings: [], llmMs: 0, retrievalMs: 0, loadMs: 0, inputTokens: 0, outputTokens: 0 });
  const confirm = vi.fn<typeof confirmVoiceProposal>().mockResolvedValue({ success: true, replayed: false, receipt: "Saved.", actions: [] });
  const reject = vi.fn<typeof rejectVoiceProposal>().mockResolvedValue({ success: true });
  const calls = new VoiceCalls({ prepare, confirm, reject });
  const { id } = calls.start(ctx(), { source: "local", timezone: "Asia/Kuala_Lumpur", language: "en" });
  const turn = (text: string, reviewedId?: string, requestId = crypto.randomUUID()) => calls.turn(ctx(), { callId: id, requestId, text, reviewedId });
  return { calls, turn, prepare, confirm, reject, id, proposal };
}
describe("live call approvals", () => {
  it("does not approve incidental yes, negation, or a request containing approval words", () => {
    for (const text of ["yes", "yes but change the date", "don't confirm change", "add a note saying confirm change", "no confirm change"]) expect(callControl(text)).not.toBe("confirm");
    expect(callControl("Yes, confirm.")).toBe("confirm");
  });
  it("requires the exact readback ID and executes the stored proposal only", async () => {
    const f = fixture(); const pending = await f.turn("Add a note to Maya");
    expect(pending.text).toContain("Discuss pricing");
    await f.turn("confirm change"); await f.turn("yes"); await f.turn("confirm change", "stale");
    expect(f.confirm).not.toHaveBeenCalled();
    const receipt = await f.turn("confirm change", pending.reviewId);
    expect(receipt.saved).toBe(true);
    expect(f.confirm).toHaveBeenCalledWith(1, 10, f.proposal);
  });
  it("caches a repeated request and never saves twice", async () => {
    const f = fixture(); const pending = await f.turn("Add note"); const id = crypto.randomUUID();
    const first = await f.turn("confirm change", pending.reviewId, id);
    expect(await f.turn("confirm change", pending.reviewId, id)).toEqual(first);
    await f.turn("confirm change", pending.reviewId);
    expect(f.confirm).toHaveBeenCalledTimes(1);
  });
  it("invalidates an old readback when the user corrects the request", async () => {
    const f = fixture(); const first = await f.turn("Add note"); const second = await f.turn("Actually change the note to send pricing");
    expect(f.reject).toHaveBeenCalledTimes(1);
    expect(second.reviewId).not.toBe(first.reviewId);
    await f.turn("confirm change", first.reviewId);
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it("cancels pending changes and rejects cross-user and logged-out sessions", async () => {
    const f = fixture(); const pending = await f.turn("Add note");
    await expect(f.calls.turn(ctx(2), { callId: f.id, requestId: crypto.randomUUID(), text: "confirm change", reviewedId: pending.reviewId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.calls.end(ctx(1, 2), f.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.turn("cancel change"); await f.turn("confirm change", pending.reviewId);
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.reject).toHaveBeenCalledTimes(1);
    await f.calls.end(ctx(), f.id);
    await expect(f.turn("read tasks")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("read-only answers never invoke confirmation", async () => {
    const f = fixture();
    f.prepare.mockResolvedValue({ text: "Two open tasks.", choices: [], proposal: null, sessionId: null, sources: [], warnings: [], llmMs: 0, retrievalMs: 0, loadMs: 0, inputTokens: 0, outputTokens: 0 });
    expect((await f.turn("Read my tasks")).text).toBe("Two open tasks.");
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it("answers a general question without calling the CRM planner or saving a change", async () => {
    const f = fixture();
    expect((await f.turn("Why is the sky blue?")).text).toBe("Blue light scatters more strongly.");
    expect(answerGeneralCallQuestion).toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it("requires the deletion-specific phrase and completed readback for HubSpot archives", async () => {
    const execute = vi.fn().mockResolvedValue("Archived.");
    const reject = vi.fn().mockResolvedValue(undefined);
    vi.mocked(prepareHubspotCall).mockResolvedValue({ text: "Archive contact Maya Chen.", change: { delete: true, execute, reject } });
    const calls = new VoiceCalls();
    const admin = { ...ctx(), user: { ...ctx().user!, role: "admin" as const } };
    const { id } = calls.start(admin, { source: "hubspot", timezone: "Asia/Kuala_Lumpur", language: "en" });
    const turn = (text: string, reviewedId?: string) => calls.turn(admin, { callId: id, requestId: crypto.randomUUID(), text, reviewedId });
    const pending = await turn("Archive Maya Chen");
    expect(pending.text).toContain("confirm delete");
    await turn("confirm change", pending.reviewId);
    await turn("confirm delete");
    await turn("confirm delete", "stale");
    expect(execute).not.toHaveBeenCalled();
    expect((await turn("confirm delete", pending.reviewId)).saved).toBe(true);
    await turn("confirm delete", pending.reviewId);
    expect(execute).toHaveBeenCalledTimes(1);
    await calls.end(admin, id);
  });
});
