import { describe, expect, it } from "vitest";
import { appRouter, ownerMatches, proposalSchema, taskMutationState } from "./routers";
import type { TrpcContext } from "./_core/context";

const unauthenticatedContext = (): TrpcContext => ({
  user: null,
  req: { protocol: "https", headers: {} } as TrpcContext["req"],
  res: {} as TrpcContext["res"],
});

describe("voice proposal contract", () => {
  it("accepts only the supported proposal types", () => {
    expect(proposalSchema.parse({ actions: [{ type: "add_note", contactName: "Maya Chen", note: "Discuss pricing" }] }).actions[0]?.type).toBe("add_note");
    expect(proposalSchema.parse({ actions: [{ type: "create_follow_up", contactName: "Maya Chen", taskTitle: "Send proposal", dueDate: "2026-09-08" }] }).actions[0]?.type).toBe("create_follow_up");
    expect(proposalSchema.parse({ actions: [{ type: "lookup_contact", contactName: "Maya Chen" }] }).actions[0]?.type).toBe("lookup_contact");
  });

  it("accepts multiple independent actions in one reviewed proposal", () => {
    const proposal = proposalSchema.parse({ actions: [{ type: "lookup_contact", contactName: "Maya Chen" }, { type: "add_note", contactName: "Acme", note: "Discuss pricing" }] });
    expect(proposal.actions).toHaveLength(2);
  });

  it("preserves unsupported requests as non-mutating proposals", () => {
    const proposal = proposalSchema.parse({ actions: [{ type: "unsupported", reason: "Sending email is not supported" }] });
    expect(proposal.actions[0]?.type).toBe("unsupported");
    expect(proposal.actions[0]?.reason).toContain("not supported");
  });

  it("protects CRM reads behind authentication", async () => {
    const caller = appRouter.createCaller(unauthenticatedContext());
    await expect(caller.contacts.list({ query: "Maya" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});


describe("protected CRM mutation boundaries", () => {
  it("rejects contact creation without an authenticated owner", async () => {
    const caller = appRouter.createCaller(unauthenticatedContext());
    await expect(caller.contacts.create({ firstName: "A", lastName: "Person" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects task listing without an authenticated owner", async () => {
    const caller = appRouter.createCaller(unauthenticatedContext());
    await expect(caller.tasks.list({ filter: "overdue" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects voice confirmation without an authenticated owner", async () => {
    const caller = appRouter.createCaller(unauthenticatedContext());
    await expect(caller.voice.confirm({ sessionId: 1, proposal: { actions: [{ type: "add_note", contactName: "Maya Chen", note: "Test" }] } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});


describe("deterministic safety helpers", () => {
  it("maps completion toggles to the correct persisted state", () => {
    expect(taskMutationState(true).status).toBe("completed");
    expect(taskMutationState(true).completedAt).toBeInstanceOf(Date);
    expect(taskMutationState(false)).toEqual({ status: "open", completedAt: null });
  });

  it("matches records only to their owning user", () => {
    expect(ownerMatches({ userId: 42 }, 42)).toBe(true);
    expect(ownerMatches({ userId: 42 }, 7)).toBe(false);
  });
});
