import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireDb, voiceSessions } from "../db";
import { trainingInput, type TrainingExample } from "../../shared/training";
import { validateValues } from "../../shared/crm";
import { studioStore, audit } from "./store";
const scope = z.object({ workspaceId: z.string().uuid() });
export const trainingRouter = router({
  list: protectedProcedure.input(scope).query(async ({ ctx, input }) => {
    const { workspace } = await studioStore.read(
      ctx.user.id,
      input.workspaceId
    );
    return (workspace.training ?? [])
      .filter(e => e.userId === ctx.user.id)
      .map(({ recordingKey, ...safe }) => safe);
  }),
  add: protectedProcedure
    .input(scope.extend(trainingInput.shape))
    .mutation(async ({ ctx, input }) => {
      await studioStore.read(ctx.user.id, input.workspaceId);
      let recordingKey: string | undefined;
      if (input.sample.task === "speech") {
        const db = await requireDb();
        const [session] = await db
          .select()
          .from(voiceSessions)
          .where(
            and(
              eq(voiceSessions.id, input.sample.sessionId),
              eq(voiceSessions.userId, ctx.user.id)
            )
          );
        if (!session?.recordingKey)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Choose one of your recorded voice sessions",
          });
        recordingKey = session.recordingKey;
      } else {
        const { expected, object, selectedRecordId } = input.sample;
        if ("operation" in expected) {
          if (
            expected.object !== object.key ||
            (expected.operation !== "create" &&
              expected.recordId !== selectedRecordId)
          )
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Expected action must match the schema and selected record",
            });
          if (expected.operation !== "delete")
            try {
              validateValues(
                object,
                expected.values,
                expected.operation === "create"
              );
            } catch (e) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: (e as Error).message,
              });
            }
        }
      }
      return studioStore.mutate(
        ctx.user.id,
        input.workspaceId,
        ["owner", "editor"],
        w => {
          w.training ??= [];
          if (w.training.length >= 2000)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Export and archive training samples before adding more",
            });
          const example: TrainingExample = {
            id: randomUUID(),
            userId: ctx.user.id,
            createdAt: new Date().toISOString(),
            sample: input.sample,
            group: input.group,
            reviewed: true,
            consent: true,
            recordingKey,
          };
          w.training.push(example);
          audit(
            w,
            ctx.user.id,
            "training.sample.reviewed",
            `${example.id}: ${input.sample.task}`
          );
          return example.id;
        }
      );
    }),
  remove: protectedProcedure
    .input(scope.extend({ sampleId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      studioStore.mutate(
        ctx.user.id,
        input.workspaceId,
        ["owner", "editor"],
        w => {
          w.training = (w.training ?? []).filter(
            e => !(e.id === input.sampleId && e.userId === ctx.user.id)
          );
          audit(w, ctx.user.id, "training.sample.removed", input.sampleId);
        }
      )
    ),
  export: protectedProcedure.input(scope).query(async ({ ctx, input }) => {
    const { workspace } = await studioStore.read(
      ctx.user.id,
      input.workspaceId
    );
    return {
      format: "localvoice-training-v1",
      examples: (workspace.training ?? [])
        .filter(e => e.userId === ctx.user.id && e.consent && e.reviewed)
        .map(({ recordingKey, ...safe }) => safe),
    };
  }),
});
