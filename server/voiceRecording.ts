import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { requireDb, voiceSessions, recordings } from "./db";
import { storagePut, storageDelete } from "./storage";
import { transcribeAudio, type TranscriptionResponse } from "./_core/voiceTranscription";
import { WorkPool } from "./_core/workPool";
import { ENV } from "./_core/env";
import { recordMetric } from "./metrics";

export const sttPool = new WorkPool(1, ENV.queueLimit, ENV.queueTimeoutMs);
export async function transcribeRecording(userId: number, buffer: Buffer, filename: string, mimeType: string, language?: string, signal?: AbortSignal, completedLiveTranscript?: TranscriptionResponse) {
  if (!buffer.length || buffer.length > 16 * 1024 * 1024) throw new TRPCError({ code: "BAD_REQUEST", message: "Audio must contain 1 byte to 16 MB" });
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  if (!["audio/webm", "audio/ogg", "audio/wav", "audio/wave", "audio/mpeg", "audio/mp3", "audio/m4a", "audio/mp4"].includes(mime)) throw new TRPCError({ code: "BAD_REQUEST", message: "Unsupported audio format" });
  const requestId = randomUUID(), start = performance.now();
  let key: string | undefined;
  let committed = false;
  try {
    signal?.throwIfAborted();
    // Save the recording while Whisper works. The previous sequence waited for a
    // disk write before sending audio to the model, adding storage latency to
    // every transcription even though both operations use the same buffer.
    const saveRecording = storagePut(`${userId}-recordings/${randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120)}`, buffer, mime);
    const runTranscription = async () => {
      if (completedLiveTranscript) return completedLiveTranscript;
      // Single retry on transient service errors (e.g. Whisper queue briefly full)
      let result = await sttPool.run(() => transcribeAudio({ audioBuffer: buffer, mimeType, language, signal, prompt: "Customer relationship management. Transcribe names and dates accurately. Do not add words that were not spoken." }), signal);
      if ("error" in result && result.code === "SERVICE_ERROR") {
        await delay(500, undefined, { signal });
        signal?.throwIfAborted();
        result = await sttPool.run(() => transcribeAudio({ audioBuffer: buffer, mimeType, language, signal, prompt: "Customer relationship management. Transcribe names and dates accurately. Do not add words that were not spoken." }), signal);
      }
      return result;
    };
    const [saved, transcriptionResult] = await Promise.allSettled([saveRecording, runTranscription()]);
    if (saved.status === "fulfilled") key = saved.value.key;
    if (saved.status === "rejected") throw saved.reason;
    const uploaded = saved.value;
    if (transcriptionResult.status === "rejected") throw transcriptionResult.reason;
    const transcription = transcriptionResult.value;
    signal?.throwIfAborted();
    if ("error" in transcription) throw new TRPCError({ code: "BAD_GATEWAY", message: "Transcription could not complete. Check the speech service and audio format." });
    if (!transcription.text.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "No speech detected. Please try again." });
    const db = await requireDb();
    const sttLatencyMs = Math.round(performance.now() - start);
    const sessionId = await db.transaction(async tx => {
      const session = await tx.insert(voiceSessions).values({ userId, transcript: transcription.text.slice(0, 10000), detectedLanguage: transcription.language, recordingKey: uploaded.key, recordingUrl: uploaded.url, status: "transcribed", sttLatencyMs });
      await tx.insert(recordings).values({ userId, filename: filename.slice(0, 255), mimeType: mime, storageKey: uploaded.key, storageUrl: uploaded.url, sizeBytes: buffer.length, voiceSessionId: session[0].insertId });
      signal?.throwIfAborted();
      return session[0].insertId;
    });
    committed = true;
    await recordMetric({ userId, requestId, sessionId, stage: "stt", outcome: "ok", durationMs: sttLatencyMs });
    return { sessionId, requestId, transcript: transcription.text.slice(0, 10000), language: transcription.language, confidence: transcription.confidence, vocabularyMatch: transcription.vocabularyMatch, recordingUrl: uploaded.url, sttLatencyMs, timing: transcription.timingMs };
  } catch (error) {
    if (key && !committed) await storageDelete(key).catch(() => {});
    await recordMetric({ userId, requestId, stage: "stt", outcome: signal?.aborted ? "cancelled" : "error", durationMs: performance.now() - start });
    throw error;
  }
}
