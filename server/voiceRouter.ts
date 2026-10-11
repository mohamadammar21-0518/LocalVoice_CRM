import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { protectedProcedure, router } from "./_core/trpc";
import { timezoneSchema, sourceSchema, proposalSchema } from "../shared/voice";
import { confirmVoiceProposal, rejectVoiceProposal } from "./voiceActions";
import { prepareVoiceTurn } from "./voiceAssistant";
import { transcribeRecording } from "./voiceRecording";
import { requireDb, voiceSessions, auditEvents, voiceMetrics } from "./db";
import { getMetricSummary, recordLatencySamples, recordMetric } from "./metrics";
import { ENV } from "./_core/env";

export const voiceRouter = router({
  transcribe: protectedProcedure.input(z.object({ audioBase64: z.string().min(1).max(23 * 1024 * 1024), filename: z.string().max(255).default("voice.webm"), mimeType: z.string().max(100).default("audio/webm"), language: z.string().max(8).optional(), prompt: z.string().max(500).optional() })).mutation(({ ctx, input }) => transcribeRecording(ctx.user.id, Buffer.from(input.audioBase64.replace(/^data:.*?;base64,/, ""), "base64"), input.filename, input.mimeType, input.language)),
  propose: protectedProcedure.input(z.object({ sessionId: z.number().int().positive(), transcript: z.string().trim().min(1).max(10000), timezone: timezoneSchema.optional(), source: sourceSchema.default("local") })).mutation(async ({ ctx, input }) => {
    const turn = await prepareVoiceTurn(ctx.user, { prompt: input.transcript, sessionId: input.sessionId, timezone: input.timezone ?? ENV.timezone, source: input.source, forceProposal: true });
    if (!turn.proposal) throw new TRPCError({ code: "BAD_REQUEST", message: turn.text });
    return { sessionId: turn.sessionId!, proposal: turn.proposal };
  }),
  confirm: protectedProcedure.input(z.object({ sessionId: z.number().int().positive(), proposal: proposalSchema })).mutation(async ({ ctx, input }) => {
    const start = performance.now();
    const result = await confirmVoiceProposal(ctx.user.id, input.sessionId, input.proposal);
    // One sample per confirmed session, including a replay after a lost response.
    const requestId = `confirm-${input.sessionId}`;
    if (!result.replayed) await recordMetric({ userId: ctx.user.id, requestId, sessionId: input.sessionId, stage: "confirm", outcome: "ok", durationMs: performance.now() - start });
    return result;
  }),
  reject: protectedProcedure.input(z.object({ sessionId: z.number().int().positive() })).mutation(({ ctx, input }) => rejectVoiceProposal(ctx.user.id, input.sessionId)),
  createManualSession: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await requireDb();
    const result = await db.insert(voiceSessions).values({ userId: ctx.user.id, transcript: "", status: "transcribed" });
    return { sessionId: result[0].insertId };
  }),
  history: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().nonnegative().default(0) }).optional()).query(async ({ ctx, input }) => {
    const db = await requireDb();
    return db.select({ id: voiceSessions.id, status: voiceSessions.status, transcript: voiceSessions.transcript, proposalJson: voiceSessions.proposalJson, confirmedResultJson: voiceSessions.confirmedResultJson, createdAt: voiceSessions.createdAt }).from(voiceSessions).where(eq(voiceSessions.userId, ctx.user.id)).orderBy(desc(voiceSessions.createdAt)).limit(input?.limit ?? 25).offset(input?.offset ?? 0);
  }),
  metrics: protectedProcedure.input(z.object({ days: z.number().int().min(1).max(90).default(7) }).optional()).query(({ ctx, input }) => getMetricSummary(ctx.user.id, input?.days)),
  playbackMetric: protectedProcedure.input(z.object({ requestId: z.string().uuid(), durationMs: z.number().int().min(0).max(300000) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [owned] = await db.select({ id: voiceMetrics.id }).from(voiceMetrics).where(and(eq(voiceMetrics.userId, ctx.user.id), eq(voiceMetrics.requestId, input.requestId))).limit(1);
    if (!owned) return { recorded: false };
    await recordMetric({ userId: ctx.user.id, requestId: input.requestId, stage: "playback", outcome: "ok", durationMs: input.durationMs });
    return { recorded: true };
  }),
  latencySamples: protectedProcedure.input(z.object({
    requestId: z.string().uuid(), language: z.string().min(2).max(8), engine: z.string().min(1).max(32),
    samples: z.array(z.object({ metric: z.enum(["partial_render", "final_transcript", "speech_to_text_ready", "tts_ready", "first_playback", "speech_to_first_playback", "frame_duration", "client_queue", "model_queue", "model_inference", "endpoint_detection", "barge_in_ready"]), durationMs: z.number().int().min(0).max(300000) })).min(1).max(64),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [owned] = await db.select({ id: voiceMetrics.id }).from(voiceMetrics).where(and(eq(voiceMetrics.userId, ctx.user.id), eq(voiceMetrics.requestId, input.requestId))).limit(1);
    if (!owned) return { recorded: false };
    await recordLatencySamples(ctx.user.id, input.requestId, input.language, input.engine, input.samples);
    return { recorded: true };
  }),
  audit: protectedProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return db.select().from(auditEvents).where(eq(auditEvents.userId, ctx.user.id)).orderBy(desc(auditEvents.createdAt)).limit(100);
  }),
});
