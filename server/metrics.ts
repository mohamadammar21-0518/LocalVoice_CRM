import { and, desc, eq, gte } from "drizzle-orm";
import { requireDb, voiceLatencySamples, voiceMetrics } from "./db";

type MetricInput = Omit<typeof voiceMetrics.$inferInsert, "id" | "createdAt">;
export async function recordMetric(input: MetricInput) {
  try {
    const db = await requireDb();
    await db.insert(voiceMetrics).values({ ...input, durationMs: Math.max(0, Math.round(input.durationMs)) }).onDuplicateKeyUpdate({ set: { durationMs: Math.max(0, Math.round(input.durationMs)), outcome: input.outcome } });
  } catch { console.warn("[Metrics] Could not persist performance sample"); }
}
export type LatencyMetric = "partial_render" | "final_transcript" | "speech_to_text_ready" | "tts_ready" | "first_playback" | "speech_to_first_playback" | "frame_duration" | "client_queue" | "model_queue" | "model_inference" | "endpoint_detection" | "barge_in_ready";
export async function recordLatencySamples(userId: number, requestId: string, language: string, engine: string, samples: { metric: LatencyMetric; durationMs: number }[]) {
  if (!samples.length) return;
  const db = await requireDb();
  await db.insert(voiceLatencySamples).values(samples.slice(0, 64).map(sample => ({
    userId, requestId, language: language.slice(0, 8), engine: engine.slice(0, 32), metric: sample.metric,
    durationMs: Math.max(0, Math.min(300000, Math.round(sample.durationMs))),
  })));
}
export function percentile(samples: number[], fraction: number) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
export async function getMetricSummary(userId: number, days = 7) {
  const db = await requireDb();
  const since = new Date(Date.now() - days * 86400000);
  const [rows, latencyRows] = await Promise.all([
    db.select().from(voiceMetrics).where(and(eq(voiceMetrics.userId, userId), gte(voiceMetrics.createdAt, since))).orderBy(desc(voiceMetrics.createdAt)).limit(5000),
    db.select().from(voiceLatencySamples).where(and(eq(voiceLatencySamples.userId, userId), gte(voiceLatencySamples.createdAt, since))).orderBy(desc(voiceLatencySamples.createdAt)).limit(10000),
  ]);
  const stages = ["stt", "intent", "retrieval", "first_audio", "turn", "confirm", "playback"] as const;
  const pipeline = stages.map(stage => {
    const group = rows.filter(row => row.stage === stage);
    const successful = group.filter(row => row.outcome === "ok");
    return { stage, count: group.length, errors: group.filter(row => row.outcome === "error").length, cancelled: group.filter(row => row.outcome === "cancelled").length, p50Ms: percentile(successful.map(row => row.durationMs), 0.5), p95Ms: percentile(successful.map(row => row.durationMs), 0.95), p99Ms: percentile(successful.map(row => row.durationMs), 0.99), coldStarts: group.filter(row => row.loadMs > 100).length, inputTokens: group.reduce((n, row) => n + row.inputTokens, 0), outputTokens: group.reduce((n, row) => n + row.outputTokens, 0) };
  });
  const latencyMetrics = [...new Set(latencyRows.map(row => row.metric))].sort().map(metric => {
    const group = latencyRows.filter(row => row.metric === metric);
    const values = group.map(row => row.durationMs);
    return { metric, count: group.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99) };
  });
  return { days, sampled: rows.length + latencyRows.length, truncated: rows.length === 5000 || latencyRows.length === 10000, stages: pipeline, latencyMetrics };
}
