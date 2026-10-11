/**
 * Voice transcription — routes to the appropriate backend.
 *
 * Modes (WHISPER_MODE in .env):
 *   "fastapi"       — persistent FastAPI server (whisper_server.py) [RECOMMENDED]
 *                     Model loads once at startup, stays warm for all requests.
 *                     Set WHISPER_SERVER_URL (default: http://localhost:8001)
 *
 *   "faster-whisper" — legacy Flask server (local_whisper_server.py)
 *                     Same model but older server design, kept for compatibility.
 *
 *   "whisper-cpp"   — whisper.cpp HTTP server
 *
 *   "ollama"        — Ollama audio endpoint (experimental, falls back to whisper-cpp)
 */
import * as fs from "fs";
import { ENV } from "./env";

// ── types ─────────────────────────────────────────────────────────────────────

export type TranscribeOptions = {
  audioUrl?: string;
  audioBuffer?: Buffer;
  mimeType?: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
};

export type WhisperSegment = {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
};

export type WhisperResponse = {
  task: "transcribe";
  language: string;
  duration: number;
  text: string;
  segments: WhisperSegment[];
  confidence?: number;
  vocabularyMatch?: string | null;
  // timing breakdown from the persistent server
  timingMs?: {
    convert: number;
    queueWait: number;
    inference: number;
    total: number;
  };
};

export type TranscriptionResponse = WhisperResponse;

export type TranscriptionError = {
  error: string;
  code: "FILE_TOO_LARGE" | "INVALID_FORMAT" | "TRANSCRIPTION_FAILED" | "UPLOAD_FAILED" | "SERVICE_ERROR";
  details?: string;
};

// ── main entry ────────────────────────────────────────────────────────────────

export async function transcribeAudio(
  options: TranscribeOptions
): Promise<TranscriptionResponse | TranscriptionError> {
  try {
    options.signal?.throwIfAborted();
    let audioBuffer: Buffer;
    let mimeType = options.mimeType ?? "audio/webm";

    if (options.audioBuffer) {
      audioBuffer = options.audioBuffer;
    } else if (options.audioUrl?.startsWith("http")) {
      return { error: "Upload audio bytes instead of a remote URL", code: "INVALID_FORMAT" };
    } else {
      if (!options.audioUrl) return { error: "Audio input is required", code: "INVALID_FORMAT" };
      const file = await fs.promises.open(options.audioUrl, "r");
      try {
        if ((await file.stat()).size > 16 * 1024 * 1024) return { error: "Audio exceeds 16 MB limit", code: "FILE_TOO_LARGE" };
        audioBuffer = await file.readFile();
      } finally { await file.close(); }
    }

    const sizeMB = audioBuffer.length / (1024 * 1024);
    if (sizeMB > 16) return { error: "Audio exceeds 16 MB limit", code: "FILE_TOO_LARGE", details: `${sizeMB.toFixed(1)} MB` };

    switch (ENV.whisperMode) {
      case "fastapi":
        return await transcribeViaFastAPI(audioBuffer, mimeType, options);
      case "faster-whisper":
        return await transcribeViaFasterWhisper(audioBuffer, mimeType, options);
      case "ollama":
        return await transcribeViaOllama(audioBuffer, mimeType, options);
      case "whisper-cpp":
      default:
        return await transcribeViaWhisperCpp(audioBuffer, mimeType, options);
    }
  } catch (err) {
    options.signal?.throwIfAborted();
    if (err instanceof Error && err.name === "TimeoutError") return { error: "Transcription timed out. Try a shorter recording.", code: "TRANSCRIPTION_FAILED" };
    return { error: "Transcription failed", code: "SERVICE_ERROR", details: err instanceof Error ? err.message : String(err) };
  }
}

// ── health check — used by app startup to detect if server is down ────────────

export async function checkWhisperHealth(): Promise<{ ok: boolean; model?: string; error?: string }> {
  const url = `${ENV.whisperServerUrl.replace(/\/$/, "")}/health`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { "X-Service-Token": process.env.VOICE_SERVICE_TOKEN ?? "" } });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const json = await resp.json() as any;
    return { ok: json.ok === true, model: json.model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unreachable" };
  }
}

// ── FastAPI persistent server ─────────────────────────────────────────────────
// Model loads once at startup — this is the recommended mode.
// Start: python whisper_server.py
// All requests hit the already-warm model. Queue wait is near-zero when idle.

async function transcribeViaFastAPI(
  audioBuffer: Buffer,
  mimeType: string,
  options: TranscribeOptions
): Promise<TranscriptionResponse | TranscriptionError> {
  const baseUrl = ENV.whisperServerUrl.replace(/\/$/, "");
  const url = `${baseUrl}/transcribe`;
  const ext = mimeTypeToExt(mimeType);
  const filename = `audio.${ext}`;

  // Build raw multipart body — avoids Node.js FormData/Blob compatibility issues
  const boundary = `----LocalVoiceBoundary${Date.now()}`;
  const CRLF = "\r\n";

  // File part header
  const fileHeader = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`
  );

  // Optional language part
  const langPart = options.language
    ? Buffer.from(
        `${CRLF}--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
        options.language
      )
    : Buffer.alloc(0);

  const closing = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);

  const promptPart = options.prompt ? Buffer.from(`${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name="prompt"${CRLF}${CRLF}${options.prompt.slice(0, 500)}`) : Buffer.alloc(0);
  const body = Buffer.concat([fileHeader, audioBuffer, langPart, promptPart, closing]);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
      "X-Service-Token": process.env.VOICE_SERVICE_TOKEN ?? "",
    },
    body: body as unknown as BodyInit,
    signal: AbortSignal.any([AbortSignal.timeout(ENV.sttTimeoutMs), ...(options.signal ? [options.signal] : [])]),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 503 || resp.status === 0) {
      return {
        error: "Whisper server not running. Start it with: python whisper_server.py",
        code: "SERVICE_ERROR",
        details: `Tried: ${url}`,
      };
    }
    return { error: "Transcription failed", code: "TRANSCRIPTION_FAILED", details: `${resp.status}: ${text}` };
  }

  const json = await resp.json() as any;

  return {
    task: "transcribe",
    language: json.language ?? "en",
    duration: (json.segments?.at(-1)?.end) ?? 0,
    text: (json.text ?? "").trim(),
    timingMs: json.timing_ms
      ? {
          convert:   json.timing_ms.convert    ?? 0,
          queueWait: json.timing_ms.queue_wait ?? 0,
          inference: json.timing_ms.inference  ?? 0,
          total:     json.timing_ms.total      ?? 0,
        }
      : undefined,
    segments: (json.segments ?? []).map((s: any, i: number) => ({
      id: i, seek: 0,
      start: s.start ?? 0, end: s.end ?? 0,
      text: s.text ?? "",
      tokens: [], temperature: 0, avg_logprob: 0, compression_ratio: 1, no_speech_prob: 0,
    })),
  };
}

// ── legacy faster-whisper Flask server ───────────────────────────────────────
// Kept for backward compatibility. Use "fastapi" mode for new installs.

async function transcribeViaFasterWhisper(
  audioBuffer: Buffer,
  mimeType: string,
  options: TranscribeOptions
): Promise<TranscriptionResponse | TranscriptionError> {
  const baseUrl = ENV.whisperBaseUrl.replace(/\/$/, "");
  const ext = mimeTypeToExt(mimeType);
  const lang = options.language ?? "en";
  const url = `${baseUrl}/transcribe?language=${lang}&ext=${ext}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: audioBuffer as unknown as BodyInit,
    signal: AbortSignal.any([AbortSignal.timeout(ENV.sttTimeoutMs), ...(options.signal ? [options.signal] : [])]),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { error: "faster-whisper server error", code: "TRANSCRIPTION_FAILED", details: `${resp.status}: ${text}` };
  }

  const json = await resp.json() as any;
  return {
    task: "transcribe",
    language: json.language ?? "en",
    duration: json.duration ?? 0,
    text: (json.text ?? "").trim(),
    segments: (json.segments ?? []).map((s: any, i: number) => ({
      id: i, seek: 0, start: s.start ?? 0, end: s.end ?? 0,
      text: s.text ?? "", tokens: [], temperature: 0,
      avg_logprob: 0, compression_ratio: 1, no_speech_prob: 0,
    })),
  };
}

// ── whisper.cpp server ────────────────────────────────────────────────────────

async function transcribeViaWhisperCpp(
  audioBuffer: Buffer,
  mimeType: string,
  options: TranscribeOptions
): Promise<TranscriptionResponse | TranscriptionError> {
  const baseUrl = ENV.whisperBaseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/inference`;
  const ext = mimeTypeToExt(mimeType);
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
    form.append("file", blob, `audio.${ext}`);
    form.append("response_format", "verbose_json");
    if (options.language) form.append("language", options.language);

    const resp = await fetch(url, { method: "POST", body: form, signal: AbortSignal.any([AbortSignal.timeout(ENV.sttTimeoutMs), ...(options.signal ? [options.signal] : [])]) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { error: "whisper.cpp error", code: "TRANSCRIPTION_FAILED", details: `${resp.status}: ${text}` };
    }
    return normalizeWhisperCppResponse(await resp.json() as any);
}

function normalizeWhisperCppResponse(json: any): WhisperResponse {
  return {
    task: "transcribe",
    language: json.language ?? "en",
    duration: json.duration ?? 0,
    text: (json.text ?? "").trim(),
    segments: (json.segments ?? []).map((s: any, i: number) => ({
      id: s.id ?? i, seek: s.seek ?? 0,
      start: s.t0 != null ? s.t0 / 100 : (s.start ?? 0),
      end: s.t1 != null ? s.t1 / 100 : (s.end ?? 0),
      text: s.text ?? "", tokens: s.tokens ?? [],
      temperature: s.temperature ?? 0, avg_logprob: s.avg_logprob ?? 0,
      compression_ratio: s.compression_ratio ?? 1, no_speech_prob: s.no_speech_prob ?? 0,
    })),
  };
}

// ── Ollama audio endpoint (experimental) ─────────────────────────────────────

async function transcribeViaOllama(
  audioBuffer: Buffer,
  mimeType: string,
  options: TranscribeOptions
): Promise<TranscriptionResponse | TranscriptionError> {
  const baseUrl = ENV.ollamaBaseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/audio/transcriptions`;
  const ext = mimeTypeToExt(mimeType);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), `audio.${ext}`);
  form.append("model", "whisper");
  form.append("response_format", "verbose_json");
  if (options.language) form.append("language", options.language);

  try {
    const resp = await fetch(url, { method: "POST", body: form, signal: AbortSignal.any([AbortSignal.timeout(ENV.sttTimeoutMs), ...(options.signal ? [options.signal] : [])]) });
    if (!resp.ok) {
      await resp.body?.cancel();
      if (resp.status === 404 || resp.status === 501) return transcribeViaWhisperCpp(audioBuffer, mimeType, options);
      return { error: "Audio service request failed", code: "TRANSCRIPTION_FAILED" };
    }
    return normalizeWhisperCppResponse(await resp.json() as any);
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  }
}

// ── utilities ─────────────────────────────────────────────────────────────────

function mimeTypeToExt(mime: string): string {
  const map: Record<string, string> = {
    "audio/webm": "webm", "audio/webm;codecs=opus": "webm",
    "audio/ogg": "ogg",   "audio/ogg;codecs=opus": "ogg",
    "audio/mp3": "mp3",   "audio/mpeg": "mp3",
    "audio/wav": "wav",   "audio/wave": "wav",
    "audio/m4a": "m4a",   "audio/mp4": "m4a",
  };
  const base = mime.split(";")[0].trim().toLowerCase();
  return map[mime] ?? map[base] ?? "webm";
}
