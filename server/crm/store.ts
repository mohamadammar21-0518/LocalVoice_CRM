import { randomUUID } from "node:crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import { requireDb } from "../db";
import {
  studioWorkspaces,
  studioMembers,
  studioRecords,
} from "../../drizzle/schema";
import type {
  Blueprint,
  CrmAction,
  CrmRecord,
  Mapping,
  ProviderId,
  Values,
} from "../../shared/crm";
import { TRPCError } from "@trpc/server";
import type { Deployment } from "./provision";
import type { TrainingExample } from "../../shared/training";

export type MemberRole = "owner" | "editor" | "viewer";
export type Proposal = {
  id: string;
  userId: number;
  sessionVersion: number;
  revision: number;
  action: CrmAction;
  before?: CrmRecord;
  state: "pending" | "executing" | "succeeded" | "rejected" | "uncertain";
  expires: number;
  result?: { id: string; message: string };
  error?: string;
};
export type Workspace = {
  id: string;
  blueprint: Blueprint;
  revision: number;
  provider: ProviderId;
  mappings: Record<string, Mapping>;
  providerMappings?: Partial<Record<ProviderId, Record<string, Mapping>>>;
  /** virtual: populated from studioRecords table; not stored in document blob */
  records: CrmRecord[];
  proposals: Proposal[];
  history: { revision: number; blueprint: Blueprint; at: string }[];
  audit: {
    id: string;
    at: string;
    userId: number;
    event: string;
    detail: string;
  }[];
  mcpTokens?: {
    id: string;
    hash: string;
    userId: number;
    sessionVersion: number;
    expires: number;
    canDraft: boolean;
  }[];
  deployment?: Deployment;
  training?: TrainingExample[];
};
export interface StudioStore {
  list(
    userId: number
  ): Promise<{ id: string; name: string; role: MemberRole }[]>;
  create(userId: number, blueprint: Blueprint): Promise<string>;
  read(
    userId: number,
    id: string
  ): Promise<{ workspace: Workspace; role: MemberRole }>;
  mutate<T>(
    userId: number,
    id: string,
    roles: MemberRole[],
    fn: (w: Workspace) => T
  ): Promise<T>;
}
export function audit(
  w: Workspace,
  userId: number,
  event: string,
  detail: string
) {
  w.audit.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    userId,
    event,
    detail,
  });
}
export function newWorkspace(blueprint: Blueprint): Workspace {
  return {
    id: randomUUID(),
    blueprint,
    revision: 1,
    provider: "local",
    mappings: {},
    records: [],
    proposals: [],
    history: [],
    audit: [],
  };
}
export function denied(): never {
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Workspace unavailable or permission denied",
  });
}
export const studioStore: StudioStore = {
  async list(userId) {
    const db = await requireDb();
    return db
      .select({
        id: studioWorkspaces.id,
        name: studioWorkspaces.name,
        role: studioMembers.role,
      })
      .from(studioMembers)
      .innerJoin(
        studioWorkspaces,
        eq(studioMembers.workspaceId, studioWorkspaces.id)
      )
      .where(eq(studioMembers.userId, userId));
  },
  async create(userId, blueprint) {
    const db = await requireDb();
    const w = newWorkspace(blueprint);
    audit(w, userId, "workspace.created", blueprint.name);
    await db.transaction(async tx => {
      await tx
        .insert(studioWorkspaces)
        .values({
          id: w.id,
          name: blueprint.name,
          document: JSON.stringify(w),
        });
      await tx
        .insert(studioMembers)
        .values({ workspaceId: w.id, userId, role: "owner" });
    });
    return w.id;
  },
  async read(userId, id) {
    const db = await requireDb();
    const [row] = await db
      .select({ document: studioWorkspaces.document, role: studioMembers.role })
      .from(studioWorkspaces)
      .innerJoin(
        studioMembers,
        and(
          eq(studioMembers.workspaceId, studioWorkspaces.id),
          eq(studioMembers.userId, userId)
        )
      )
      .where(eq(studioWorkspaces.id, id));
    if (!row) denied();
    const workspace = JSON.parse(row.document) as Workspace;
    workspace.records = await loadRecordsFromDb(id);
    return { workspace, role: row.role };
  },
  async mutate(userId, id, roles, fn) {
    const db = await requireDb();
    return db.transaction(async tx => {
      const [row] = await tx
        .select()
        .from(studioWorkspaces)
        .where(eq(studioWorkspaces.id, id))
        .for("update");
      const [member] = await tx
        .select()
        .from(studioMembers)
        .where(
          and(
            eq(studioMembers.workspaceId, id),
            eq(studioMembers.userId, userId)
          )
        );
      if (!row || !member || !roles.includes(member.role)) denied();
      const w = JSON.parse(row.document) as Workspace;
      const existing = await tx
        .select()
        .from(studioRecords)
        .where(
          and(
            eq(studioRecords.workspaceId, id),
            isNull(studioRecords.deletedAt)
          )
        );
      w.records = existing.map(r => ({
        id: r.id,
        object: r.objectKey,
        values: r.data as Values,
        version: r.version,
        updatedAt: r.updatedAt.toISOString(),
      }));
      const result = fn(w);
      const document = JSON.stringify({ ...w, records: [] });
      if (Buffer.byteLength(document) > 12 * 1024 * 1024)
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message:
            "Workspace storage limit reached. Export and archive records before continuing.",
        });
      const previous = new Map(existing.map(r => [r.id, r]));
      const next = new Set(w.records.map(r => r.id));
      for (const record of w.records) {
        const old = previous.get(record.id);
        if (!old)
          await tx
            .insert(studioRecords)
            .values({
              id: record.id,
              workspaceId: id,
              objectKey: record.object,
              data: record.values,
              version: record.version,
              updatedAt: new Date(record.updatedAt),
            });
        else if (record.version !== old.version)
          await tx
            .update(studioRecords)
            .set({
              data: record.values,
              version: record.version,
              updatedAt: new Date(record.updatedAt),
            })
            .where(
              and(
                eq(studioRecords.workspaceId, id),
                eq(studioRecords.id, record.id)
              )
            );
      }
      for (const old of existing)
        if (!next.has(old.id))
          await tx
            .update(studioRecords)
            .set({ deletedAt: new Date(), version: old.version + 1 })
            .where(
              and(
                eq(studioRecords.workspaceId, id),
                eq(studioRecords.id, old.id)
              )
            );
      await tx
        .update(studioWorkspaces)
        .set({ document, name: w.blueprint.name })
        .where(eq(studioWorkspaces.id, id));
      return result;
    });
  },
};

/** Insert a new CrmRecord into the studioRecords table. */
export async function insertStudioRecord(
  workspaceId: string,
  record: CrmRecord
): Promise<void> {
  const db = await requireDb();
  await db.insert(studioRecords).values({
    id: record.id,
    workspaceId,
    objectKey: record.object,
    data: record.values as Record<string, unknown>,
  });
}

/** Soft-delete a studioRecords row by setting deletedAt. */
export async function softDeleteStudioRecord(
  workspaceId: string,
  recordId: string
): Promise<void> {
  const db = await requireDb();
  await db
    .update(studioRecords)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(studioRecords.workspaceId, workspaceId),
        eq(studioRecords.id, recordId)
      )
    );
}

/** Update a studioRecords row's data in place. */
export async function updateStudioRecord(
  workspaceId: string,
  record: CrmRecord
): Promise<void> {
  const db = await requireDb();
  await db
    .update(studioRecords)
    .set({
      data: record.values as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(studioRecords.workspaceId, workspaceId),
        eq(studioRecords.id, record.id)
      )
    );
}

/** Load all non-deleted records for a workspace from studioRecords. */
export async function loadRecordsFromDb(
  workspaceId: string
): Promise<CrmRecord[]> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(studioRecords)
    .where(
      and(
        eq(studioRecords.workspaceId, workspaceId),
        isNull(studioRecords.deletedAt)
      )
    );
  return rows.map(r => ({
    id: r.id,
    object: r.objectKey,
    values: r.data as Values,
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Count non-deleted records for a workspace. */
export async function countRecordsInDb(workspaceId: string): Promise<number> {
  const db = await requireDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(studioRecords)
    .where(
      and(
        eq(studioRecords.workspaceId, workspaceId),
        isNull(studioRecords.deletedAt)
      )
    );
  return Number(row?.n ?? 0);
}

/**
 * Like studioStore.read() but populates workspace.records from studioRecords table
 * for local-provider workspaces (virtual field — not stored in the blob).
 */
export async function loadWorkspaceWithRecords(
  userId: number,
  id: string
): Promise<{ workspace: Workspace; role: MemberRole }> {
  return studioStore.read(userId, id);
}

/**
 * One-time migration: moves records[] from studioWorkspaces JSON blob into
 * the studioRecords table, then strips them from the blob.
 * Idempotent: skips workspaces that already have rows in studioRecords.
 */
export async function migrateRecordsFromBlob(): Promise<void> {
  const db = await requireDb();
  const workspaces = await db
    .select({ id: studioWorkspaces.id, document: studioWorkspaces.document })
    .from(studioWorkspaces);
  for (const ws of workspaces) {
    await db.transaction(async tx => {
      const [locked] = await tx
        .select()
        .from(studioWorkspaces)
        .where(eq(studioWorkspaces.id, ws.id))
        .for("update");
      const parsed = JSON.parse(locked.document) as Workspace;
      if (!Array.isArray(parsed.records) || !parsed.records.length) return;
      for (const record of parsed.records) {
        const [existing] = await tx
          .select()
          .from(studioRecords)
          .where(eq(studioRecords.id, record.id));
        if (existing) {
          if (
            existing.workspaceId !== ws.id ||
            existing.objectKey !== record.object ||
            JSON.stringify(existing.data) !== JSON.stringify(record.values) ||
            existing.deletedAt
          )
            throw new Error(
              "Conflicting legacy Studio records require manual reconciliation"
            );
          continue;
        }
        await tx
          .insert(studioRecords)
          .values({
            id: record.id,
            workspaceId: ws.id,
            objectKey: record.object,
            data: record.values,
            version: record.version,
            updatedAt: new Date(record.updatedAt),
          });
      }
      parsed.records = [];
      await tx
        .update(studioWorkspaces)
        .set({ document: JSON.stringify(parsed) })
        .where(eq(studioWorkspaces.id, ws.id));
    });
  }
}
