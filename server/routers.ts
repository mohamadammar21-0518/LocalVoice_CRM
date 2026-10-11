import { salesforceRouter } from "./salesforce";
import { voiceRouter } from "./voiceRouter";
import { integrationRouter } from "./integrationRouter";
import { revokeUserSessions } from "./db";
import { localCookieOptions } from "./_core/localAuth";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { protectedProcedure, publicProcedure, adminProcedure, router } from "./_core/trpc";
import {
  getContact,
  getDashboard,
  getDb,
  getInteractions,
  getTasks,
  seedDemoData,
  searchContacts,
  contacts,
  followUpTasks,
  interactions,
  users,
  listUsers,
  createUser,
  deleteUser,
  updateUserRole,
} from "./db";
import { semanticSearchContacts, invalidateContactCache } from "./_core/embeddings";
import { ENV } from "./_core/env";
import { requireDb } from "./db";
import bcrypt from "bcryptjs";

export { proposalActionSchema, proposalSchema } from "../shared/voice";

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Builds status/completedAt for a task toggle mutation. */
export function taskMutationState(completed: boolean) {
  return {
    status: completed ? ("completed" as const) : ("open" as const),
    completedAt: completed ? new Date() : null,
  };
}

/** Guards that a DB record belongs to the calling user. */
export function ownerMatches(record: { userId: number }, userId: number) {
  return record.userId === userId;
}

/**
 * Extra guard used inside procedures where `protectedProcedure` already
 * ensures `ctx.user` is non-null, but TypeScript still needs narrowing.
 */
function requireUser(ctx: { user: { id: number } | null }) {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return ctx.user;
}

// ── Input schemas ─────────────────────────────────────────────────────────────

const contactInput = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  company: z.string().max(160).optional(),
  role: z.string().max(160).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(60).optional(),
  notes: z.string().max(5000).optional(),
});

const paginationInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});

// ── App router ────────────────────────────────────────────────────────────────

export const appRouter = router({
  // ── Health ─────────────────────────────────────────────────────────────────
  system: router({
    health: publicProcedure.query(() => ({ ok: true })),
  }),

  // ── Auth ───────────────────────────────────────────────────────────────────
  auth: router({
    me: publicProcedure.query(({ ctx }) => {
      if (!ctx.user) return null;
      // Never expose the password hash or session version to the client.
      const { passwordHash: _hash, sessionVersion: _sv, ...safe } = ctx.user;
      return safe;
    }),

    logout: protectedProcedure.mutation(async ({ ctx }) => {
      await revokeUserSessions(ctx.user.id);
      ctx.res.clearCookie(COOKIE_NAME, localCookieOptions(ctx.req));
      return { success: true } as const;
    }),
  }),

  // ── Admin: multi-user management ───────────────────────────────────────────
  admin: router({
    listUsers: adminProcedure.query(() => listUsers()),

    revokeSessions: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        await revokeUserSessions(input.id);
        return { success: true };
      }),

    resetPassword: adminProcedure
      .input(z.object({ id: z.number().int().positive(), password: z.string().min(12).max(200) }))
      .mutation(async ({ input }) => {
        const db = await requireDb();
        await db
          .update(users)
          .set({ passwordHash: await bcrypt.hash(input.password, 12) })
          .where(eq(users.id, input.id));
        await revokeUserSessions(input.id);
        return { success: true };
      }),

    createUser: adminProcedure
      .input(
        z.object({
          username: z.string().min(3).max(32).regex(/^[a-z0-9_]+$/),
          password: z.string().min(12).max(200),
          name: z.string().max(100).optional(),
          role: z.enum(["user", "admin"]).default("user"),
        }),
      )
      .mutation(async ({ input }) => {
        try {
          await createUser(input);
          return { success: true };
        } catch (e) {
          throw new TRPCError({
            code: "CONFLICT",
            message: e instanceof Error ? e.message : "Failed to create user",
          });
        }
      }),

    deleteUser: adminProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.id === input.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot delete yourself" });
        }
        await deleteUser(input.id);
        return { success: true };
      }),

    updateRole: adminProcedure
      .input(z.object({ id: z.number().int(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ input }) => {
        await updateUserRole(input.id, input.role);
        return { success: true };
      }),
  }),

  // ── Dashboard ──────────────────────────────────────────────────────────────
  dashboard: router({
    get: protectedProcedure.query(({ ctx }) => getDashboard(ctx.user.id)),

    seed: adminProcedure.mutation(({ ctx }) => {
      if (ENV.isProduction) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Demo data is disabled in production" });
      }
      return seedDemoData(ctx.user.id);
    }),
  }),

  // ── Integration routers ────────────────────────────────────────────────────
  integrations: integrationRouter,
  salesforce: salesforceRouter,

  // ── Contacts ───────────────────────────────────────────────────────────────
  contacts: router({
    list: protectedProcedure
      .input(
        z.object({ query: z.string().max(240).optional() })
          .merge(paginationInput)
          .optional(),
      )
      .query(({ ctx, input }) =>
        searchContacts(ctx.user.id, input?.query ?? "", input?.limit ?? 50, input?.offset ?? 0),
      ),

    get: protectedProcedure
      .input(z.object({ id: z.number().int() }))
      .query(({ ctx, input }) => getContact(requireUser(ctx).id, input.id)),

    create: protectedProcedure
      .input(contactInput)
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const result = await db
          .insert(contacts)
          .values({ ...input, userId: user.id, email: input.email || undefined });
        invalidateContactCache(user.id);
        return getContact(user.id, result[0].insertId);
      }),

    update: protectedProcedure
      .input(contactInput.extend({ id: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        if (!(await getContact(user.id, input.id))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
        }
        const { id, ...values } = input;
        await db
          .update(contacts)
          .set({ ...values, email: values.email || null })
          .where(and(eq(contacts.id, id), eq(contacts.userId, user.id)));
        invalidateContactCache(user.id);
        return getContact(user.id, id);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        await db.transaction(async (tx) => {
          const [contact] = await tx
            .select()
            .from(contacts)
            .where(and(eq(contacts.id, input.id), eq(contacts.userId, ctx.user.id)))
            .for("update");
          if (!contact) throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
          await tx
            .delete(contacts)
            .where(and(eq(contacts.id, input.id), eq(contacts.userId, ctx.user.id)));
        });
        invalidateContactCache(ctx.user.id);
        return { success: true };
      }),

    search: protectedProcedure
      .input(z.object({ query: z.string().max(240), limit: z.number().int().min(1).max(20).default(8) }))
      .query(({ ctx, input }) => searchContacts(ctx.user.id, input.query, input.limit)),

    semanticSearch: protectedProcedure
      .input(z.object({ query: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx);
        // Try vector search first; fall back to LIKE when embeddings are unavailable.
        try {
          return await semanticSearchContacts(user.id, input.query);
        } catch {
          return searchContacts(user.id, input.query);
        }
      }),
  }),

  // ── Interactions ───────────────────────────────────────────────────────────
  interactions: router({
    list: protectedProcedure
      .input(
        z.object({ contactId: z.number().int().positive().optional() })
          .merge(paginationInput)
          .optional(),
      )
      .query(({ ctx, input }) =>
        getInteractions(
          requireUser(ctx).id,
          input?.contactId,
          input?.limit ?? 50,
          input?.offset ?? 0,
        ),
      ),

    create: protectedProcedure
      .input(
        z.object({
          contactId: z.number().int(),
          kind: z.enum(["note", "call", "meeting", "email"]).default("note"),
          body: z.string().min(1).max(10000),
          occurredAt: z.date().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx);
        if (!(await getContact(user.id, input.contactId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
        }
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db
          .insert(interactions)
          .values({ ...input, userId: user.id, occurredAt: input.occurredAt ?? new Date() });
        return { success: true };
      }),
  }),

  // ── Tasks / follow-ups ─────────────────────────────────────────────────────
  tasks: router({
    list: protectedProcedure
      .input(
        z.object({ filter: z.enum(["all", "open", "overdue"]).default("all") })
          .merge(paginationInput)
          .optional(),
      )
      .query(({ ctx, input }) =>
        getTasks(
          requireUser(ctx).id,
          input?.filter ?? "all",
          undefined,
          input?.limit ?? 50,
          input?.offset ?? 0,
        ),
      ),

    create: protectedProcedure
      .input(
        z.object({
          contactId: z.number().int(),
          title: z.string().min(1).max(240),
          dueAt: z.date(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx);
        if (!(await getContact(user.id, input.contactId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
        }
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.insert(followUpTasks).values({ ...input, userId: user.id });
        return { success: true };
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number().int(),
          contactId: z.number().int(),
          title: z.string().min(1).max(240),
          dueAt: z.date(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx);
        if (!(await getContact(user.id, input.contactId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
        }
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        const existing = await db
          .select({ id: followUpTasks.id })
          .from(followUpTasks)
          .where(and(eq(followUpTasks.id, input.id), eq(followUpTasks.userId, user.id)))
          .limit(1);
        if (!existing[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Follow-up not found" });

        const { id, ...values } = input;
        await db
          .update(followUpTasks)
          .set(values)
          .where(and(eq(followUpTasks.id, id), eq(followUpTasks.userId, user.id)));
        return { success: true };
      }),

    toggle: protectedProcedure
      .input(z.object({ id: z.number().int(), completed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db
          .update(followUpTasks)
          .set(taskMutationState(input.completed))
          .where(and(eq(followUpTasks.id, input.id), eq(followUpTasks.userId, user.id)));
        return { success: true };
      }),
  }),

  // ── Voice ──────────────────────────────────────────────────────────────────
  voice: voiceRouter,
});

export type AppRouter = typeof appRouter;
