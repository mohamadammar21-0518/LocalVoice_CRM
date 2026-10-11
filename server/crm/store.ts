import { randomUUID } from "node:crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import { requireDb } from "../db";
import { studioWorkspaces, studioMembers, studioRecords } from "../../drizzle/schema";
import type { Blueprint, CrmAction, CrmRecord, Mapping, ProviderId, Values } from "../../shared/crm";
import { TRPCError } from "@trpc/server";
import type { Deployment } from "./provision";

export type MemberRole = "owner" | "editor" | "viewer";
export type Proposal = { id: string; userId: number; sessionVersion: number; revision: number; action: CrmAction; before?: CrmRecord; state: "pending" | "executing" | "succeeded" | "rejected" | "uncertain"; expires: number; result?: { id: string; message: string }; error?: string };
export type Workspace = { id: string; blueprint: Blueprint; revision: number; provider: ProviderId; mappings: Record<string, Mapping>;
  /** virtual: populated from studioRecords table; not stored in document blob */
  records: CrmRecord[]; proposals: Proposal[]; history: { revision: number; blueprint: Blueprint; at: string }[]; audit: { id: string; at: string; userId: number; event: string; detail: string }[]; mcpTokens?: { id: string; hash: string; userId: number; sessionVersion: number; expires: number; canDraft: boolean }[]; deployment?: Deployment };
export interface StudioStore {
  list(userId: number): Promise<{ id: string; name: string; role: MemberRole }[]>;
  create(userId: number, blueprint: Blueprint): Promise<string>;
  read(userId: number, id: string): Promise<{ workspace: Workspace; role: MemberRole }>;
  mutate<T>(userId: number, id: string, roles: MemberRole[], fn: (w: Workspace) => T): Promise<T>;
}
export function audit(w: Workspace, userId: number, event: string, detail: string) { w.audit.push({ id: randomUUID(), at: new Date().toISOString(), userId, event, detail }); }
export function newWorkspace(blueprint: Blueprint): Workspace { return { id: randomUUID(), blueprint, revision: 1, provider: "local", mappings: {}, records: [], proposals: [], history: [], audit: [] }; }
export function denied(): never { throw new TRPCError({ code: "FORBIDDEN", message: "Workspace unavailable or permission denied" }); }
export const studioStore: StudioStore = {
  async list(userId) {
    const db = await requireDb();
    return db.select({ id: studioWorkspaces.id, name: studioWorkspaces.name, role: studioMembers.role }).from(studioMembers).innerJoin(studioWorkspaces, eq(studioMembers.workspaceId, studioWorkspaces.id)).where(eq(studioMembers.userId, userId));
  },
  async create(userId, blueprint) {
    const db = await requireDb(); const w = newWorkspace(blueprint); audit(w, userId, "workspace.created", blueprint.name);
    await db.transaction(async tx => {
      await tx.insert(studioWorkspaces).values({ id: w.id, name: blueprint.name, document: JSON.stringify(w) });
      await tx.insert(studioMembers).values({ workspaceId: w.id, userId, role: "owner" });
    }); return w.id;
  },
  async read(userId, id) {
    const db = await requireDb();
    const [row] = await db.select({ document: studioWorkspaces.document, role: studioMembers.role }).from(studioWorkspaces).innerJoin(studioMembers, and(eq(studioMembers.workspaceId, studioWorkspaces.id), eq(studioMembers.userId, userId))).where(eq(studioWorkspaces.id, id));
    if (!row) denied(); return { workspace: JSON.parse(row.document) as Workspace, role: row.role };
  },
  async mutate(userId, id, roles, fn) {
    const db = await requireDb();
    return db.transaction(async tx => {
      const [row] = await tx.select().from(studioWorkspaces).where(eq(studioWorkspaces.id, id)).for("update");
      const [member] = await tx.select().from(studioMembers).where(and(eq(studioMembers.workspaceId, id), eq(studioMembers.userId, userId)));
      if (!row || !member || !roles.includes(member.role)) denied();
      const w = JSON.parse(row.document) as Workspace;
      const result = fn(w);
      const document = JSON.stringify(w);
      if (Buffer.byteLength(document) > 12 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Workspace storage limit reached. Export and archive records before continuing." });
      await tx.update(studioWorkspaces).set({ document, name: w.blueprint.name }).where(eq(studioWorkspaces.id, id));
      return result;
    });
  },
};

/** Insert a new CrmRecord into the studioRecords table. */
export async function insertStudioRecord(workspaceId: string, record: CrmRecord): Promise<void> {
  const db = await requireDb();
  await db.insert(studioRecords).values({
    id: record.id,
    workspaceId,
    objectKey: record.object,
    data: record.values as Record<string, unknown>,
  });
}

/** Soft-delete a studioRecords row by setting deletedAt. */
export async function softDeleteStudioRecord(workspaceId: string, recordId: string): Promise<void> {
  const db = await requireDb();
  await db.update(studioRecords)
    .set({ deletedAt: new Date() })
    .where(and(eq(studioRecords.workspaceId, workspaceId), eq(studioRecords.id, recordId)));
}

/** Update a studioRecords row's data in place. */
export async function updateStudioRecord(workspaceId: string, record: CrmRecord): Promise<void> {
  const db = await requireDb();
  await db.update(studioRecords)
    .set({ data: record.values as Record<string, unknown>, updatedAt: new Date() })
    .where(and(eq(studioRecords.workspaceId, workspaceId), eq(studioRecords.id, record.id)));
}

/** Load all non-deleted records for a workspace from studioRecords. */
export async function loadRecordsFromDb(workspaceId: string): Promise<CrmRecord[]> {
  const db = await requireDb();
  const rows = await db.select().from(studioRecords)
    .where(and(eq(studioRecords.workspaceId, workspaceId), isNull(studioRecords.deletedAt)));
  return rows.map(r => ({
    id: r.id,
    object: r.objectKey,
    values: r.data as Values,
    version: 0,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Count non-deleted records for a workspace. */
export async function countRecordsInDb(workspaceId: string): Promise<number> {
  const db = await requireDb();
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(studioRecords)
    .where(and(eq(studioRecords.workspaceId, workspaceId), isNull(studioRecords.deletedAt)));
  return Number(row?.n ?? 0);
}

/**
 * Like studioStore.read() but populates workspace.records from studioRecords table
 * for local-provider workspaces (virtual field — not stored in the blob).
 */
export async function loadWorkspaceWithRecords(userId: number, id: string): Promise<{ workspace: Workspace; role: MemberRole }> {
  const { workspace, role } = await studioStore.read(userId, id);
  if (workspace.provider === "local") {
    workspace.records = await loadRecordsFromDb(id);
  }
  return { workspace, role };
}

/**
 * One-time migration: moves records[] from studioWorkspaces JSON blob into
 * the studioRecords table, then strips them from the blob.
 * Idempotent: skips workspaces that already have rows in studioRecords.
 */
export async function migrateRecordsFromBlob(): Promise<void> {
  const db = await requireDb();
  const workspaces = await db.select({ id: studioWorkspaces.id, document: studioWorkspaces.document }).from(studioWorkspaces);
  for (const ws of workspaces) {
    const parsed = JSON.parse(ws.document) as Workspace;
    if (!Array.isArray(parsed.records) || parsed.records.length === 0) continue;
    // Check if already migrated
    const [existing] = await db.select({ n: sql<number>`count(*)` }).from(studioRecords).where(eq(studioRecords.workspaceId, ws.id));
    if (Number(existing?.n ?? 0) > 0) continue;
    // Insert each record
    for (const record of parsed.records) {
      await db.insert(studioRecords).values({
        id: record.id,
        workspaceId: ws.id,
        objectKey: record.object,
        data: record.values as Record<string, unknown>,
      }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
    }
    // Strip records from blob
    const recordCount = parsed.records.length;
    parsed.records = [];
    await db.update(studioWorkspaces).set({ document: JSON.stringify(parsed) }).where(eq(studioWorkspaces.id, ws.id));
    console.log(`[Studio] Migrated ${recordCount} record(s) from workspace ${ws.id} blob to studioRecords table`);
  }
}

