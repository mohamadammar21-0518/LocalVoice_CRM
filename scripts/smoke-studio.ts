import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { requireDb, closeDb } from "../server/db";
import { users, studioMembers, studioRecords, studioWorkspaces } from "../drizzle/schema";
import { studioStore } from "../server/crm/store";
import { createStudioService } from "../server/crm/service";
import { trainingRouter } from "../server/crm/training";
import { crmTemplates } from "../shared/crm";
import type { TrpcContext } from "../server/_core/context";

// Explicit opt-in: creates isolated fixtures, then removes only those exact IDs.
if (!process.argv.includes("--run")) throw new Error("Use --run to test the configured database with temporary fixtures");
const db = await requireDb();
const testUsers: number[] = [];
let workspaceId: string | undefined;
try {
  for (let n = 0; n < 2; n++) {
    const [row] = await db.insert(users).values({ openId: `studio-smoke-${randomUUID()}`, name: "Temporary Studio test" }).$returningId();
    testUsers.push(row.id);
  }
  const context = (id: number) => ({ user: { id, sessionVersion: 0 } }) as TrpcContext;
  const ctx = context(testUsers[0]);
  const blueprint = structuredClone(crmTemplates[0].blueprint);
  workspaceId = await studioStore.create(testUsers[0], blueprint);
  const service = createStudioService(studioStore);
  await assert.rejects(studioStore.read(testUsers[1], workspaceId));
  const proposal = await service.draft(ctx, workspaceId, { operation: "create", object: "companies", values: { name: "Smoke fixture" } });
  const results = await Promise.all([service.confirm(ctx, workspaceId, proposal.id), service.confirm(ctx, workspaceId, proposal.id)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await studioStore.read(testUsers[0], workspaceId)).workspace.records.length, 1);
  const update = await service.draft(ctx, workspaceId, { operation: "update", object: "companies", recordId: results[0].id, values: { name: "Updated fixture" } });
  await service.confirm(ctx, workspaceId, update.id);
  const before = (await studioStore.read(testUsers[0], workspaceId)).workspace;
  assert.equal(before.records[0].version, 2);
  await assert.rejects(studioStore.mutate(testUsers[0], workspaceId, ["owner"], w => { w.records = []; w.blueprint.name = "must roll back"; throw new Error("test rollback"); }));
  const after = (await studioStore.read(testUsers[0], workspaceId)).workspace;
  assert.deepEqual(after.records, before.records);
  assert.equal(after.blueprint.name, before.blueprint.name);
  await db.insert(studioMembers).values({ workspaceId, userId: testUsers[1], role: "editor" });
  const owner = trainingRouter.createCaller(ctx);
  const other = trainingRouter.createCaller(context(testUsers[1]));
  const input = { workspaceId, group: "fixture", consent: true as const, reviewed: true as const, sample: { task: "command" as const, prompt: "Create a company named Example", object: blueprint.objects.find(o => o.key === "companies")!, today: "2026-10-12", expected: { operation: "create" as const, object: "companies", values: { name: "Example" } } } };
  await owner.add(input);
  assert.equal((await owner.list({ workspaceId })).length, 1);
  assert.equal((await other.list({ workspaceId })).length, 0);
  assert.equal((await other.export({ workspaceId })).examples.length, 0);
  await assert.rejects(owner.add({ ...input, consent: false } as never));
  const deletion = await service.draft(ctx, workspaceId, { operation: "delete", object: "companies", recordId: results[0].id, values: {} });
  await service.confirm(ctx, workspaceId, deletion.id, "DELETE");
  assert.equal((await studioStore.read(testUsers[0], workspaceId)).workspace.records.length, 0);
  const [deleted] = await db.select().from(studioRecords).where(eq(studioRecords.id, results[0].id));
  assert.ok(deleted.deletedAt);
  console.log("PASS: MySQL isolation, concurrent idempotency, persisted versions, rollback, training privacy/consent, soft deletion");
} finally {
  if (workspaceId) {
    await db.delete(studioRecords).where(eq(studioRecords.workspaceId, workspaceId));
    await db.delete(studioMembers).where(eq(studioMembers.workspaceId, workspaceId));
    await db.delete(studioWorkspaces).where(eq(studioWorkspaces.id, workspaceId));
  }
  for (const id of testUsers) await db.delete(users).where(eq(users.id, id));
  await closeDb();
  console.log("Removed only this run's temporary test users and workspace.");
}
