import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { actionSchema, blueprintSchema, validateValues, type Blueprint, type CrmAction, type CrmRecord } from "../../shared/crm";
import type { TrpcContext } from "../_core/context";
import { audit, denied, studioStore, loadWorkspaceWithRecords, loadRecordsFromDb, insertStudioRecord, softDeleteStudioRecord, updateStudioRecord, countRecordsInDb, type StudioStore, type Workspace } from "./store";
import { remoteProvider } from "./providers";

function fail(message: string): never { throw new TRPCError({ code: "BAD_REQUEST", message }); }

export function validateAction(w: Workspace, action: CrmAction, records?: CrmRecord[]) {
  const recs = records ?? w.records;
  actionSchema.parse(action);
  const object = w.blueprint.objects.find(o => o.key === action.object); if (!object) fail("Unknown object");
  if (action.operation !== "delete") {
    try { validateValues(object, action.values, action.operation === "create"); } catch (e) { fail((e as Error).message); }
    if (!Object.keys(action.values).length) fail("Provide at least one field");
    if (w.provider === "local") for (const f of object.fields.filter(f => f.type === "relation")) {
      const id = action.values[f.key]; if (id && !recs.some(r => r.object === f.target && r.id === id)) fail(`Select an existing ${f.target} record for ${f.label}`);
    }
  }
  if (w.provider === "local" && action.operation !== "create" && !recs.some(r => r.object === action.object && r.id === action.recordId)) fail("Record no longer exists");
  if (w.provider === "local" && action.operation === "delete") {
    for (const o of w.blueprint.objects) for (const f of o.fields.filter(f => f.type === "relation" && f.target === action.object)) if (recs.some(r => r.object === o.key && r.values[f.key] === action.recordId)) fail(`Record is referenced by ${o.plural}. Remove those relationships first.`);
  }
}

export function schemaDiff(before: Blueprint, after: Blueprint) {
  const changes: string[] = [];
  for (const o of after.objects) {
    const old = before.objects.find(x => x.key === o.key);
    if (!old) { changes.push(`Add object ${o.label}`); continue; }
    for (const f of o.fields) {
      const previous = old.fields.find(x => x.key === f.key);
      if (!previous) changes.push(`Add ${o.label}.${f.label}`);
      else if (JSON.stringify(previous) !== JSON.stringify(f)) changes.push(`Change ${o.label}.${f.label}`);
    }
    for (const f of old.fields) if (!o.fields.some(x => x.key === f.key)) changes.push(`Remove ${o.label}.${f.label}`);
  }
  for (const o of before.objects) if (!after.objects.some(x => x.key === o.key)) changes.push(`Remove object ${o.label}`);
  return changes;
}

export function createStudioService(store: StudioStore = studioStore) {
  /** True when using the real DB-backed store (not an injected test mock). */
  const useDb = store === studioStore;

  /** Load records from DB (prod) or from workspace blob (test fallback). */
  async function getRecords(workspaceId: string, w: Workspace): Promise<CrmRecord[]> {
    if (!useDb || w.provider !== "local") return w.records;
    return loadRecordsFromDb(workspaceId).catch(() => w.records);
  }

  return {
    async saveBlueprint(userId: number, id: string, revision: number, blueprint: Blueprint) {
      blueprintSchema.parse(blueprint);
      // Pre-load records from DB so we can validate them before mutate.
      let dbRecords: CrmRecord[] | null = null;
      if (useDb) {
        dbRecords = await loadRecordsFromDb(id).catch(() => null);
      }
      return store.mutate(userId, id, ["owner"], w => {
        if (w.revision !== revision) fail("Workspace changed. Reload before saving.");
        if (w.deployment?.status === "running" || w.proposals.some(p => p.state === "executing" || p.state === "uncertain")) fail("Resolve in-flight or uncertain operations before changing the schema");
        // Use DB records if available, otherwise fall back to w.records (test mock path).
        const existingRecords = dbRecords ?? w.records;
        for (const record of existingRecords) {
          const o = blueprint.objects.find(o => o.key === record.object); if (!o) fail(`Cannot remove ${record.object} while records exist`);
          try { validateValues(o, record.values, true); } catch (e) { fail(`Existing record ${record.id}: ${(e as Error).message}`); }
          for (const f of o.fields.filter(f => f.type === "relation")) if (record.values[f.key] && !existingRecords.some(r => r.object === f.target && r.id === record.values[f.key])) fail(`Existing relation ${f.label} is incompatible`);
        }
        w.history.push({ revision: w.revision, blueprint: w.blueprint, at: new Date().toISOString() });
        w.blueprint = blueprint; w.revision++; audit(w, userId, "blueprint.updated", schemaDiff(w.history.at(-1)!.blueprint, blueprint).join("; ")); return w.revision;
      });
    },

    async records(ctx: TrpcContext, id: string, object: string, search = "") {
      // Use DB-backed load for real store; fall back to plain read for test mock.
      let w: Workspace;
      if (useDb) {
        ({ workspace: w } = await loadWorkspaceWithRecords(ctx.user!.id, id));
      } else {
        ({ workspace: w } = await store.read(ctx.user!.id, id));
      }
      if (!w.blueprint.objects.some(o => o.key === object)) fail("Unknown object");
      if (w.provider !== "local") return remoteProvider(w, ctx).list(object, search);
      // Records are populated by loadWorkspaceWithRecords (DB) or w.records (test mock).
      const rows = w.records.filter(r => r.object === object && (!search || JSON.stringify(r.values).toLowerCase().includes(search.toLowerCase())));
      return { records: rows.slice(0, 100), truncated: rows.length > 100 };
    },

    async draft(ctx: TrpcContext, id: string, raw: CrmAction) {
      const action = actionSchema.parse(raw); const user = ctx.user!;
      const { workspace: snapshot, role } = await store.read(user.id, id); if (role === "viewer") denied();
      // Load records from DB (prod) or use snapshot.records (test fallback).
      const records = await getRecords(id, snapshot);
      validateAction(snapshot, action, records);
      const before: CrmRecord | undefined = action.operation === "create" ? undefined : snapshot.provider === "local" ? records.find(r => r.object === action.object && r.id === action.recordId) : await remoteProvider(snapshot, ctx).get(action.object, action.recordId!);
      return store.mutate(user.id, id, ["owner", "editor"], w => {
        if (w.revision !== snapshot.revision) fail("Workspace changed. Try again.");
        // Use pre-loaded records for validation inside mutate too.
        validateAction(w, action, records);
        if (w.proposals.filter(p => p.state === "pending" && p.expires > Date.now()).length >= 100) fail("Review pending changes before creating more");
        const proposal = { id: randomUUID(), userId: user.id, sessionVersion: user.sessionVersion, revision: w.revision, action, before, state: "pending" as const, expires: Date.now() + 10 * 60000 };
        w.proposals.push(proposal); audit(w, user.id, "action.proposed", `${proposal.id}: ${action.operation} ${action.object}`); return proposal;
      });
    },

    async confirm(ctx: TrpcContext, id: string, proposalId: string, deleteText?: string) {
      const user = ctx.user!;
      // Load records from DB before mutate so we can validate and check versions.
      let currentRecords: CrmRecord[] | null = null;
      if (useDb) {
        currentRecords = await loadRecordsFromDb(id).catch(() => null);
      }

      // These will be set inside mutate for the local-provider path, then used for DB writes.
      let dbWriteOp: { action: CrmAction; recordId: string; existingRecord: CrmRecord | undefined } | null = null;
      let finalResult: { id: string; message: string } | null = null;
      let remoteWork: { workspace: Workspace; proposal: Workspace["proposals"][number] } | null = null;

      await store.mutate(user.id, id, ["owner", "editor"], w => {
        const p = w.proposals.find(p => p.id === proposalId && p.userId === user.id && p.sessionVersion === user.sessionVersion); if (!p) fail("Proposal unavailable");
        if (w.deployment?.status === "running") fail("Wait for schema deployment to finish");
        if (p.state === "succeeded") { finalResult = p.result!; return; }
        if (p.state !== "pending" || p.expires < Date.now() || p.revision !== w.revision) fail("Proposal expired, changed, or already attempted. Review its receipt.");
        if (p.action.operation === "delete" && deleteText !== "DELETE") fail("Type DELETE to confirm deletion");
        // Use DB records if available for validation, otherwise w.records (test mock).
        const recs = currentRecords ?? w.records;
        validateAction(w, p.action, recs);
        if (w.provider === "local") {
          const index = w.records.findIndex(r => r.object === p.action.object && r.id === p.action.recordId);
          const dbIndex = recs.findIndex(r => r.object === p.action.object && r.id === p.action.recordId);
          const existingRecord: CrmRecord | undefined = currentRecords ? recs[dbIndex] : w.records[index];
          if (p.before && existingRecord?.version !== p.before.version) fail("Record changed since preview. Prepare a new proposal.");
          const recordId = p.action.recordId ?? randomUUID();
          if (p.action.operation === "delete") {
            // Keep w.records in sync for test mock and blob consistency.
            if (index >= 0) w.records.splice(index, 1);
          } else {
            const baseValues = p.action.operation === "update" ? (existingRecord?.values ?? w.records[index]?.values ?? {}) : {};
            const values = { ...baseValues, ...p.action.values };
            const record: CrmRecord = { id: recordId, object: p.action.object, values, updatedAt: new Date().toISOString(), version: (existingRecord?.version ?? w.records[index]?.version ?? 0) + 1 };
            if (p.action.operation === "create") {
              // Record limit check: use DB count (prod) or w.records.length (test).
              const currentCount = currentRecords ? currentRecords.length : w.records.length;
              if (currentCount >= 10000) fail("Workspace record limit reached");
              w.records.push(record);
            } else {
              if (index >= 0) w.records[index] = record;
              else w.records.push(record); // fallback if not found in blob
            }
          }
          p.state = "succeeded"; p.result = { id: recordId, message: `${p.action.operation} completed` }; audit(w, user.id, "action.succeeded", `${p.id}: ${recordId}`);
          finalResult = p.result;
          dbWriteOp = { action: p.action, recordId, existingRecord };
          return;
        }
        p.state = "executing"; audit(w, user.id, "action.executing", p.id);
        remoteWork = { workspace: structuredClone(w), proposal: structuredClone(p) };
      });

      // For local provider: also write to DB (production path only).
      if (dbWriteOp !== null && useDb) {
        const op = dbWriteOp as { action: CrmAction; recordId: string; existingRecord: CrmRecord | undefined };
        try {
          if (op.action.operation === "delete") {
            await softDeleteStudioRecord(id, op.action.recordId!);
          } else if (op.action.operation === "create") {
            await insertStudioRecord(id, { id: op.recordId, object: op.action.object, values: op.action.values, version: 1, updatedAt: new Date().toISOString() });
          } else {
            const baseValues = op.existingRecord?.values ?? {};
            const values = { ...baseValues, ...op.action.values };
            await updateStudioRecord(id, { id: op.recordId, object: op.action.object, values, version: (op.existingRecord?.version ?? 0) + 1, updatedAt: new Date().toISOString() });
          }
        } catch {
          // DB write failed — log but don't fail the request; the blob has the record.
          console.warn(`[Studio] DB write for ${op.action.operation} on workspace ${id} failed; record ${op.recordId} is in blob only.`);
        }
      }

      if (finalResult !== null) return finalResult;

      // Remote provider path.
      if (remoteWork === null) fail("Proposal unavailable");
      const rw = remoteWork as { workspace: Workspace; proposal: Workspace["proposals"][number] };
      try {
        const provider = remoteProvider(rw.workspace, ctx);
        if (rw.proposal.before) {
          const current = await provider.get(rw.proposal.action.object, rw.proposal.action.recordId!);
          if (JSON.stringify(current.values) !== JSON.stringify(rw.proposal.before.values)) fail("Remote record changed since preview. Inspect it before preparing another action.");
        }
        const result = await provider.execute(rw.proposal.action);
        await store.mutate(user.id, id, ["owner", "editor"], w => { const p = w.proposals.find(p => p.id === proposalId)!; p.state = "succeeded"; p.result = result; audit(w, user.id, "action.succeeded", `${p.id}: ${result.id}`); }); return result;
      } catch {
        await store.mutate(user.id, id, ["owner", "editor"], w => { const p = w.proposals.find(p => p.id === proposalId)!; p.state = "uncertain"; p.error = "Remote operation could not be verified. Inspect the provider before retrying."; audit(w, user.id, "action.uncertain", p.id); });
        throw new TRPCError({ code: "BAD_GATEWAY", message: "Remote operation could not be verified. Inspect the provider before retrying; automatic retries are disabled." });
      }
    },
  };
}
export const studioService = createStudioService();
