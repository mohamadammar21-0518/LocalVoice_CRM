import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { hubspot, listHubSpotPage } from "./hubspot";
import { importHubSpotPage } from "./hubspotImport";
import { syncHubSpotRecord, reconcileHubSpotSync } from "./hubspotSync";
import { requireDb } from "./db";
import { hubspotSyncJobs } from "../drizzle/schema";
import { TRPCError } from "@trpc/server";
import { withHubspot, hubspotAccess } from "./hubspotAuth";

const sharedHubspot = adminProcedure.use(({ ctx, next }) => withHubspot(ctx.user, async () => {
  if (hubspotAccess()?.mode !== "server" || !hubspotAccess()?.token) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Shared import/sync is disconnected. Use your HubSpot workspace for OAuth account records." });
  return next();
}));

// A shared server HubSpot token is an account-wide credential: only administrators use it.
export const integrationRouter = router({
  hubspotStatus: protectedProcedure.query(({ ctx }) => withHubspot(ctx.user, async () => ({ ...hubspot.status(), configured: ctx.user.role === "admin" && hubspotAccess()?.mode === "server" && hubspot.status().configured, authorized: ctx.user.role === "admin" }))),
  hubspotContacts: sharedHubspot.input(z.object({ after: z.string().max(100).optional() }).optional()).query(({ input }) => listHubSpotPage("contacts", input?.after)),
  importPage: sharedHubspot.input(z.object({ kind: z.enum(["contacts", "notes", "tasks"]), after: z.string().max(100).optional(), apply: z.boolean().default(false), fingerprint: z.string().length(64).optional() })).mutation(({ ctx, input }) => importHubSpotPage(ctx.user.id, input.kind, input.after, input.apply, input.fingerprint)),
  syncContact: sharedHubspot.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => syncHubSpotRecord(ctx.user.id, "contact", input.id)),
  syncNote: sharedHubspot.input(z.object({ interactionId: z.number().int().positive() })).mutation(({ ctx, input }) => syncHubSpotRecord(ctx.user.id, "note", input.interactionId)),
  syncTask: sharedHubspot.input(z.object({ taskId: z.number().int().positive() })).mutation(({ ctx, input }) => syncHubSpotRecord(ctx.user.id, "task", input.taskId)),
  syncJobs: adminProcedure.query(async ({ ctx }) => { const db = await requireDb(); return db.select().from(hubspotSyncJobs).where(eq(hubspotSyncJobs.userId, ctx.user.id)).orderBy(desc(hubspotSyncJobs.updatedAt)).limit(100); }),
  reconcileSync: sharedHubspot.input(z.object({ kind: z.enum(["contact", "note", "task"]), localId: z.number().int().positive(), remoteId: z.string().regex(/^\d+$/).max(64) })).mutation(({ ctx, input }) => reconcileHubSpotSync(ctx.user.id, input.kind, input.localId, input.remoteId)),
});
