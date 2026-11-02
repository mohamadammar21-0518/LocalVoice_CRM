import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  blueprintSchema,
  crmTemplates,
  validateValues,
} from "../../shared/crm";
import { createStudioService, schemaDiff } from "./service";
import {
  newWorkspace,
  type StudioStore,
  type Workspace,
  type MemberRole,
} from "./store";
import type { TrpcContext } from "../_core/context";
import { validMcpToken } from "./mcp";

const remote = vi.hoisted(() => ({ get: vi.fn(), execute: vi.fn() }));
vi.mock("./providers", () => ({ remoteProvider: () => remote }));
const ctx = (id = 1, sessionVersion = 0) =>
  ({ user: { id, sessionVersion } }) as TrpcContext;
let workspace: Workspace;
let memberships: Map<number, MemberRole>;
let service: ReturnType<typeof createStudioService>;
let queue: Promise<unknown>;
beforeEach(() => {
  workspace = newWorkspace(structuredClone(crmTemplates[0].blueprint));
  memberships = new Map([
    [1, "owner"],
    [2, "viewer"],
    [3, "editor"],
  ]);
  queue = Promise.resolve();
  vi.clearAllMocks();
  const store: StudioStore = {
    async list() {
      return [];
    },
    async create() {
      return workspace.id;
    },
    async read(userId, id) {
      if (id !== workspace.id || !memberships.has(userId))
        throw new Error("Denied");
      return {
        workspace: structuredClone(workspace),
        role: memberships.get(userId)!,
      };
    },
    mutate(userId, id, roles, fn) {
      const next = queue.then(() => {
        if (id !== workspace.id || !roles.includes(memberships.get(userId)!))
          throw new Error("Denied");
        const copy = structuredClone(workspace);
        const result = fn(copy);
        workspace = copy;
        return result;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
  service = createStudioService(store);
});
const create = (name = "Acme") =>
  service.draft(ctx(), workspace.id, {
    operation: "create",
    object: "companies",
    values: { name },
  });
describe("CRM schema validation", () => {
  it("validates every bundled template", () => {
    for (const t of crmTemplates)
      expect(blueprintSchema.safeParse(t.blueprint).success).toBe(true);
  });
  it("rejects duplicate objects, reserved fields and missing relation targets", () => {
    const b = structuredClone(workspace.blueprint);
    b.objects.push(b.objects[0]);
    expect(blueprintSchema.safeParse(b).success).toBe(false);
    b.objects.pop();
    b.objects[0].fields[0].key = "constructor";
    expect(blueprintSchema.safeParse(b).success).toBe(false);
    b.objects[0].fields[0] = {
      key: "parent",
      label: "Parent",
      type: "relation",
      required: false,
      target: "missing",
      options: [],
      aliases: [],
    };
    expect(blueprintSchema.safeParse(b).success).toBe(false);
  });
  it("rejects invalid dates, unknown fields and string numbers", () => {
    const tasks = workspace.blueprint.objects.find(o => o.key === "tasks")!;
    expect(() => validateValues(tasks, { dueDate: "2026-02-30" })).toThrow();
    expect(() =>
      validateValues(tasks, { title: "Call", hacked: "yes" })
    ).toThrow();
    expect(() =>
      validateValues(
        workspace.blueprint.objects.find(o => o.key === "deals")!,
        { amount: "12" }
      )
    ).toThrow();
  });
  it("provides a schema diff", () => {
    const b = structuredClone(workspace.blueprint);
    b.objects.pop();
    expect(schemaDiff(workspace.blueprint, b)).toContain("Remove object Task");
  });
});
describe("reviewed local writes", () => {
  it("drafts without writing and confirms exactly once across concurrent calls", async () => {
    const p = await create();
    expect(workspace.records).toHaveLength(0);
    const results = await Promise.all([
      service.confirm(ctx(), workspace.id, p.id),
      service.confirm(ctx(), workspace.id, p.id),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(workspace.records).toHaveLength(1);
    expect(
      workspace.audit.filter(a => a.event === "action.succeeded")
    ).toHaveLength(1);
  });
  it("rejects viewers, foreign users and foreign workspaces", async () => {
    const action = {
      operation: "create" as const,
      object: "companies",
      values: { name: "Acme" },
    };
    await expect(service.draft(ctx(2), workspace.id, action)).rejects.toThrow();
    await expect(
      service.draft(ctx(99), workspace.id, action)
    ).rejects.toThrow();
    await expect(
      service.records(ctx(), "another-workspace", "companies")
    ).rejects.toThrow();
  });
  it("binds confirmation to proposal owner and login session", async () => {
    const p = await create();
    await expect(service.confirm(ctx(3), workspace.id, p.id)).rejects.toThrow();
    await expect(
      service.confirm(ctx(1, 1), workspace.id, p.id)
    ).rejects.toThrow();
    expect(workspace.records).toHaveLength(0);
  });
  it("rejects expired and schema-stale proposals", async () => {
    const p = await create();
    workspace.proposals[0].expires = 0;
    await expect(service.confirm(ctx(), workspace.id, p.id)).rejects.toThrow();
    workspace.proposals[0].expires = Date.now() + 10000;
    workspace.revision++;
    await expect(service.confirm(ctx(), workspace.id, p.id)).rejects.toThrow();
  });
  it("blocks an update if the record changed after preview", async () => {
    const p = await create();
    const r = await service.confirm(ctx(), workspace.id, p.id);
    const a = await service.draft(ctx(), workspace.id, {
      operation: "update",
      object: "companies",
      recordId: r.id,
      values: { name: "A" },
    });
    const b = await service.draft(ctx(), workspace.id, {
      operation: "update",
      object: "companies",
      recordId: r.id,
      values: { name: "B" },
    });
    await service.confirm(ctx(), workspace.id, a.id);
    await expect(service.confirm(ctx(), workspace.id, b.id)).rejects.toThrow(
      /changed/
    );
    expect(workspace.records[0].values.name).toBe("A");
  });
  it("requires DELETE and rejects dangling relationships", async () => {
    const p = await create();
    const company = await service.confirm(ctx(), workspace.id, p.id);
    const contact = await service.draft(ctx(), workspace.id, {
      operation: "create",
      object: "contacts",
      values: { name: "Maya", company: company.id },
    });
    await service.confirm(ctx(), workspace.id, contact.id);
    await expect(
      service.draft(ctx(), workspace.id, {
        operation: "delete",
        object: "companies",
        recordId: company.id,
        values: {},
      })
    ).rejects.toThrow(/referenced/);
    const deletion = await service.draft(ctx(), workspace.id, {
      operation: "delete",
      object: "contacts",
      recordId: workspace.records[1].id,
      values: {},
    });
    await expect(
      service.confirm(ctx(), workspace.id, deletion.id)
    ).rejects.toThrow(/DELETE/);
    await service.confirm(ctx(), workspace.id, deletion.id, "DELETE");
    expect(workspace.records).toHaveLength(1);
  });
  it("rejects relations outside this workspace", async () => {
    await expect(
      service.draft(ctx(), workspace.id, {
        operation: "create",
        object: "contacts",
        values: { name: "Maya", company: "foreign-id" },
      })
    ).rejects.toThrow(/existing/);
  });
  it("blocks schema changes that invalidate records", async () => {
    const p = await create();
    await service.confirm(ctx(), workspace.id, p.id);
    const b = structuredClone(workspace.blueprint);
    b.objects = b.objects.filter(o => o.key !== "companies");
    b.objects.find(o => o.key === "contacts")!.fields = b.objects
      .find(o => o.key === "contacts")!
      .fields.filter(f => f.key !== "company");
    await expect(service.saveBlueprint(1, workspace.id, 1, b)).rejects.toThrow(
      /records exist/
    );
    expect(workspace.revision).toBe(1);
  });
  it("versions compatible schema edits and blocks viewers", async () => {
    const b = structuredClone(workspace.blueprint);
    b.name = "My CRM";
    await expect(
      service.saveBlueprint(2, workspace.id, 1, b)
    ).rejects.toThrow();
    await service.saveBlueprint(1, workspace.id, 1, b);
    expect(workspace.revision).toBe(2);
    expect(workspace.history).toHaveLength(1);
  });
});
describe("remote uncertainty", () => {
  it("persists uncertainty and never retries a write after a network failure", async () => {
    workspace.provider = "twenty";
    remote.execute.mockRejectedValue(new Error("timeout"));
    const p = await create();
    await expect(service.confirm(ctx(), workspace.id, p.id)).rejects.toThrow(
      /could not be verified/
    );
    expect(workspace.proposals[0].state).toBe("uncertain");
    await expect(service.confirm(ctx(), workspace.id, p.id)).rejects.toThrow();
    expect(remote.execute).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite a remote record changed since preview", async () => {
    workspace.provider = "twenty";
    const record = {
      id: "r1",
      object: "companies",
      values: { name: "Before" },
      version: 0,
      updatedAt: "",
    };
    remote.get
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce({ ...record, values: { name: "Changed" } });
    const p = await service.draft(ctx(), workspace.id, {
      operation: "update",
      object: "companies",
      recordId: "r1",
      values: { name: "After" },
    });
    await expect(service.confirm(ctx(), workspace.id, p.id)).rejects.toThrow();
    expect(remote.execute).not.toHaveBeenCalled();
  });
});
describe("MCP token binding", () => {
  it("accepts only unexpired, correctly scoped hashes for the active session", () => {
    const token = "secret-test-token";
    workspace.mcpTokens = [
      {
        id: "t",
        userId: 1,
        sessionVersion: 2,
        hash: createHash("sha256").update(token).digest("hex"),
        expires: Date.now() + 10000,
        canDraft: false,
      },
    ];
    expect(validMcpToken(workspace, token, 1, 2)).toBeTruthy();
    expect(validMcpToken(workspace, "wrong", 1, 2)).toBeUndefined();
    expect(validMcpToken(workspace, token, 2, 2)).toBeUndefined();
    expect(validMcpToken(workspace, token, 1, 3)).toBeUndefined();
    workspace.mcpTokens[0].expires = 0;
    expect(validMcpToken(workspace, token, 1, 2)).toBeUndefined();
  });
});
