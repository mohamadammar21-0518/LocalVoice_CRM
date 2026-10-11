import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { confirmVoiceProposal, rejectVoiceProposal, resolveProposalContacts, storeProposal } from "./voiceActions";
import { requireDb, searchContacts } from "./db";
import { proposalSchema } from "../shared/voice";

vi.mock("./db", async importOriginal => ({ ...await importOriginal<typeof import("./db")>(), requireDb: vi.fn(), searchContacts: vi.fn() }));
const baseProposal = () => proposalSchema.parse({ version: 1, timezone: "Asia/Kuala_Lumpur", actions: [{ type: "add_note", contactId: 10, contactName: "Maya Chen", note: "Discussed the budget" }, { type: "create_follow_up", contactId: 10, contactName: "Maya Chen", taskTitle: "Send proposal", dueDate: "2026-10-09" }] });
type Row = Record<string, unknown>;
function transactionStore() {
  let state: Record<string, Row[]> = {
    voiceSessions: [{ id: 1, userId: 7, status: "proposed", proposalVersion: 1, proposalJson: JSON.stringify(baseProposal()), confirmedResultJson: null }],
    contacts: [{ id: 10, userId: 7, firstName: "Maya", lastName: "Chen" }, { id: 11, userId: 8, firstName: "Private", lastName: "Person" }],
    interactions: [], followUpTasks: [], auditEvents: [],
  };
  let gate = Promise.resolve();
  const locks: string[] = [];
  let failTable: string | null = null;
  const dialect = new MySqlDialect();
  const matches = (row: Row, condition: SQL) => {
    const query = dialect.sqlToQuery(condition);
    const columns = Array.from(query.sql.matchAll(/`[^`]+`\.`([^`]+)` = \?/g), match => match[1]);
    if (!columns.length) throw new Error(`Unexpected query ${query.sql}`);
    return columns.every((column, index) => row[column] === query.params[index]);
  };
  const tx = {
    select: () => ({ from: (table: Parameters<typeof getTableName>[0]) => ({ where: (condition: SQL) => {
      const name = getTableName(table);
      const result = () => state[name].filter(row => matches(row, condition));
      return { for: async (mode: string) => { locks.push(`${name}:${mode}`); return result(); }, then: (resolve: (rows: Row[]) => void, reject: (error: unknown) => void) => Promise.resolve().then(result).then(resolve, reject) };
    } }) }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({ values: async (values: Row) => {
      const name = getTableName(table); if (failTable === name) throw new Error("Injected storage failure");
      const id = state[name].length + 100; state[name].push({ ...values, id }); return [{ insertId: id }];
    } }),
    update: (table: Parameters<typeof getTableName>[0]) => ({ set: (values: Row) => ({ where: async (condition: SQL) => { for (const row of state[getTableName(table)]) if (matches(row, condition)) Object.assign(row, values); } }) }),
  };
  const database = { transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
    const previous = gate; let unlock!: () => void; gate = new Promise<void>(resolve => { unlock = resolve; }); await previous;
    const snapshot = structuredClone(state);
    try { return await callback(tx); } catch (error) { state = snapshot; throw error; } finally { unlock(); }
  } };
  return { database, get state() { return state; }, locks, fail: (table: string) => { failTable = table; } };
}
let store: ReturnType<typeof transactionStore>;
beforeEach(() => { vi.clearAllMocks(); store = transactionStore(); vi.mocked(requireDb).mockResolvedValue(store.database as never); });
describe("confirmed CRM batches", () => {
  it("rolls back all writes when any action fails", async () => {
    store.fail("followUpTasks");
    await expect(confirmVoiceProposal(7, 1, baseProposal())).rejects.toThrow("Injected");
    expect(store.state.interactions).toHaveLength(0); expect(store.state.followUpTasks).toHaveLength(0); expect(store.state.auditEvents).toHaveLength(0); expect(store.state.voiceSessions[0].status).toBe("proposed");
  });
  it("serializes duplicate confirmations and returns the committed receipt", async () => {
    const [first, retry] = await Promise.all([confirmVoiceProposal(7, 1, baseProposal()), confirmVoiceProposal(7, 1, baseProposal())]);
    expect(first.replayed).toBe(false); expect(retry.replayed).toBe(true); expect(retry.receipt).toBe(first.receipt);
    expect(store.state.interactions).toHaveLength(1); expect(store.state.followUpTasks).toHaveLength(1); expect(store.state.auditEvents).toHaveLength(1);
    expect(store.locks).toContain("voiceSessions:update"); expect(store.locks).toContain("contacts:update");
    expect(store.state.followUpTasks[0].dueAt).toEqual(new Date("2026-10-09T01:00:00Z"));
  });
  it("rejects stale revisions and changed replays", async () => {
    const stale = { ...baseProposal(), version: 0 };
    await expect(confirmVoiceProposal(7, 1, stale)).rejects.toMatchObject({ code: "CONFLICT" });
    await confirmVoiceProposal(7, 1, baseProposal());
    const changed = baseProposal(); changed.actions[0].note = "Different approved text";
    await expect(confirmVoiceProposal(7, 1, changed)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.state.interactions).toHaveLength(1);
  });
  it("cannot confirm another owner's session or contact", async () => {
    await expect(confirmVoiceProposal(8, 1, baseProposal())).rejects.toMatchObject({ code: "NOT_FOUND" });
    const crossOwner = baseProposal(); crossOwner.actions[0].contactId = 11;
    await expect(confirmVoiceProposal(7, 1, crossOwner)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(store.state.interactions).toHaveLength(0);
  });
  it("rolls back even when audit persistence fails after the record inserts", async () => {
    store.fail("auditEvents"); await expect(confirmVoiceProposal(7, 1, baseProposal())).rejects.toThrow();
    expect(store.state.interactions).toHaveLength(0); expect(store.state.voiceSessions[0].status).toBe("proposed");
  });
  it("does not change a committed session when it is discarded or regenerated", async () => {
    await confirmVoiceProposal(7, 1, baseProposal());
    await expect(rejectVoiceProposal(7, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(storeProposal(7, 1, { ...baseProposal(), actions: baseProposal().actions.map(action => ({ ...action, candidates: [] })) })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.state.voiceSessions[0].status).toBe("confirmed");
  });
  it("leaves duplicate exact names unresolved for explicit selection", async () => {
    vi.mocked(searchContacts).mockResolvedValue([{ id: 10, firstName: "Maya", lastName: "Chen", company: "A", email: "a@example.com" }, { id: 12, firstName: "Maya", lastName: "Chen", company: "B", email: "b@example.com" }] as never);
    const proposal = await resolveProposalContacts(7, baseProposal());
    expect(proposal.actions[0].contactId).toBeNull(); expect(proposal.actions[0].candidates).toHaveLength(2);
    expect(searchContacts).toHaveBeenCalledWith(7, "Maya Chen", 20);
  });
});
