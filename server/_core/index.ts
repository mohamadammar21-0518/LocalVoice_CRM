import "dotenv/config";
import { registerSalesforceCallback } from "../salesforce";
import express, { type RequestHandler } from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { authenticateRequest, registerLocalAuthRoutes } from "./localAuth";
import { securityMiddleware, rateLimiter } from "./security";
import { ENV, validateEnvironment } from "./env";
import { requireDb, recordings, closeDb, searchContacts } from "../db";
import { storageLocalPath } from "../storage";
import { prepareVoiceTurn } from "../voiceAssistant";
import { transcribeRecording } from "../voiceRecording";
import { voiceRequestSchema } from "../../shared/voice";
import { synthesize, splitForFastFirstAudio } from "./tts";
import { recordMetric } from "../metrics";
import { BusyError, WorkPool } from "./workPool";
import { AudioCache } from "./audioCache";
import { checkReadiness, poolStatus } from "./health";
import { warmLLM } from "./llm";
import { transcribeAudio } from "./voiceTranscription";
import { sttPool } from "../voiceRecording";
import { correctCrmVocabulary, liveSpeech } from "../liveSpeech";

// ── Module-level singletons ───────────────────────────────────────────────────

const audioCache = new AudioCache();
const turnPool = new WorkPool(2, ENV.queueLimit, ENV.queueTimeoutMs);
const activeRequests = new Set<AbortController>();

// ── Middleware helpers ────────────────────────────────────────────────────────

/** Validates the session cookie/Bearer token and stores the user on res.locals. */
const requireAuthentication: RequestHandler = async (req, res, next) => {
  try {
    const user = await authenticateRequest(req);
    if (!user) {
      res.status(401).json({ error: "Please log in" });
      return;
    }
    res.locals.user = user;
    next();
  } catch {
    res.status(503).json({ error: "Authentication service unavailable" });
  }
};

/**
 * Creates an AbortController for the request/response pair.
 * The controller is aborted when the client disconnects before the response
 * is finished, so downstream async operations can stop early.
 */
function requestController(req: express.Request, res: express.Response) {
  const controller = new AbortController();
  activeRequests.add(controller);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
    activeRequests.delete(controller);
  };
  req.once("aborted", onClose);
  res.once("close", onClose);
  return controller;
}

/** Returns a safe, non-leaking error message for voice API responses. */
function errorMessage(error: unknown): string {
  if (error instanceof BusyError) return error.message;
  if (error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR") return error.message;
  return "The request could not complete. Check the local voice services and try again.";
}

// ── App factory ───────────────────────────────────────────────────────────────

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  if (ENV.trustProxy) app.set("trust proxy", "loopback");

  // Security headers and CSRF/origin enforcement run before everything else.
  app.use(securityMiddleware);

  // PCM dictation sends ~4 frames/sec, so it has its own limiter.
  const apiLimiter = rateLimiter(180, 60000);
  app.use("/api", (req, res, next) =>
    req.path === "/voice/dictate" ? next() : apiLimiter(req, res, next),
  );

  app.use(express.json({ limit: "23mb" }));

  registerLocalAuthRoutes(app);
  registerSalesforceCallback(app);

  // ── Health endpoints ────────────────────────────────────────────────────────

  app.get("/api/health/live", (_req, res) => res.json({ ok: true }));

  app.get("/api/health/ready", async (_req, res) => {
    const health = await checkReadiness();
    res.status(health.ready ? 200 : 503).json({ ready: health.ready });
  });

  app.get("/api/health/details", requireAuthentication, async (_req, res) => {
    res.json({ ...await checkReadiness(), pools: poolStatus(), turns: turnPool.status });
  });

  // ── Recording file downloads ────────────────────────────────────────────────
  // Owner-scoped: the key in the URL is validated against the authenticated user.

  app.get("/uploads/:key", requireAuthentication, async (req, res) => {
    try {
      const db = await requireDb();
      const [recording] = await db
        .select()
        .from(recordings)
        .where(
          and(
            eq(recordings.storageKey, req.params.key),
            eq(recordings.userId, res.locals.user.id),
          ),
        );
      if (!recording) {
        res.status(404).json({ error: "Recording not found" });
        return;
      }
      res.type(recording.mimeType).sendFile(storageLocalPath(recording.storageKey));
    } catch {
      res.status(503).json({ error: "Recording unavailable" });
    }
  });

  // ── Live dictation (Vosk English) ──────────────────────────────────────────

  app.post("/api/voice/live/start", requireAuthentication, rateLimiter(10, 60000), async (_req, res) => {
    try {
      const records = await searchContacts(res.locals.user.id, "", 100);
      const vocabulary = [...new Set(records.flatMap(record => [`${record.firstName} ${record.lastName}`, record.company].filter((value): value is string => Boolean(value?.trim()))))];
      res.set("Cache-Control", "no-store").json({ id: liveSpeech.start(res.locals.user.id, vocabulary) });
    } catch {
      res.status(429).json({ error: "Live speech is busy" });
    }
  });

  app.delete("/api/voice/live/:id", requireAuthentication, async (req, res) => {
    if (liveSpeech.delete(req.params.id, res.locals.user.id)) {
      // Best-effort: tell the Whisper service to release the Vosk decoder.
      await fetch(
        `${ENV.whisperServerUrl.replace(/\/$/, "")}/dictate/${encodeURIComponent(req.params.id)}`,
        {
          method: "DELETE",
          headers: { "X-Service-Token": process.env.VOICE_SERVICE_TOKEN ?? "" },
          signal: AbortSignal.timeout(3000),
        },
      ).catch(() => {});
    }
    res.json({ ok: true });
  });

  app.post(
    "/api/voice/dictate",
    requireAuthentication,
    rateLimiter(360, 60000),
    express.raw({ type: "audio/wav", limit: "65kb" }),
    async (req, res) => {
      const controller = requestController(req, res);
      const id = req.get("X-Live-Id") ?? "";
      const session = liveSpeech.get(id, res.locals.user.id);
      const sequence = Number(req.get("X-Live-Sequence"));
      const final = req.get("X-Live-Final") === "1";
      let locked = false;

      try {
        // Guard: session must exist, must be idle, and the sequence must be in order.
        const sessionInvalid =
          !session ||
          session.busy ||
          session.chunks.length ||
          sequence !== session.frame ||
          !Number.isInteger(sequence) ||
          sequence > 520;
        if (sessionInvalid) {
          res.status(409).json({ error: "Dictation session unavailable" });
          return;
        }

        if (!Buffer.isBuffer(req.body) || req.body.length < 44) {
          res.status(400).json({ error: "Expected PCM WAV" });
          return;
        }

        session.busy = true;
        locked = true;
        session.engine = "vosk";

        const serviceStarted = performance.now();
        const response = await fetch(
          `${ENV.whisperServerUrl.replace(/\/$/, "")}/dictate/${encodeURIComponent(id)}?sequence=${sequence}&final=${final}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "audio/wav",
              "X-Service-Token": process.env.VOICE_SERVICE_TOKEN ?? "",
            },
            body: new Uint8Array(req.body),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          },
        );

        if (!response.ok) {
          res.status(503).json({ error: "English dictation unavailable" });
          return;
        }

        const result = (await response.json()) as { text: string; duration: number; confidence?: number; queue_ms?: number; inference_ms?: number };
        if (controller.signal.aborted) return;

        session.frame++;
        const corrected = correctCrmVocabulary(result.text, session.vocabulary);
        if (final) {
          session.chunks.push({
            task: "transcribe",
            text: corrected.text.slice(0, 10000),
            language: "en",
            duration: result.duration,
            segments: [],
            confidence: result.confidence,
            vocabularyMatch: corrected.match,
          });
        }

        res.set("Cache-Control", "no-store").json({
          text: corrected.text, final, confidence: result.confidence, vocabularyMatch: corrected.match,
          modelQueueMs: Math.max(0, result.queue_ms ?? 0),
          modelInferenceMs: Math.max(0, result.inference_ms ?? 0),
          serviceRoundTripMs: Math.max(0, Math.round(performance.now() - serviceStarted)),
        });
      } catch {
        if (!controller.signal.aborted) {
          res.status(503).json({ error: "English dictation unavailable" });
        }
      } finally {
        if (session && locked) session.busy = false;
        activeRequests.delete(controller);
      }
    },
  );

  // ── Multilingual preview transcription (Whisper) ──────────────────────────

  app.post(
    "/api/voice/preview",
    requireAuthentication,
    rateLimiter(60, 60000),
    express.raw({ type: "audio/wav", limit: "400kb" }),
    async (req, res) => {
      const controller = requestController(req, res);
      let locked: ReturnType<typeof liveSpeech.get>;

      try {
        const language = req.get("X-Audio-Language") || "en";
        if (!["en", "ms"].includes(language)) {
          res.status(400).json({ error: "Choose English or Malay" });
          return;
        }
        if (!Buffer.isBuffer(req.body) || req.body.length < 44) {
          res.status(400).json({ error: "Upload PCM WAV audio" });
          return;
        }

        const id = req.get("X-Live-Id");
        const final = req.get("X-Live-Final") === "1";
        const sequence = Number(req.get("X-Live-Sequence"));
        const session = id ? liveSpeech.get(id, res.locals.user.id) : undefined;

        const sessionInvalid =
          id &&
          (!session ||
            session.engine === "vosk" ||
            session.busy ||
            !Number.isInteger(sequence) ||
            sequence !== session.chunks.length ||
            sequence >= 120);
        if (sessionInvalid) {
          res.status(409).json({ error: "Live speech session is unavailable" });
          return;
        }

        // Previews never queue behind full transcriptions and never write CRM records.
        if (!final && (sttPool.status.active || sttPool.status.queued)) {
          res.status(429).json({ error: "Speech service is busy" });
          return;
        }

        if (session) {
          session.busy = true;
          locked = session;
        }

        const result = await sttPool.run(
          () =>
            transcribeAudio({
              audioBuffer: req.body,
              mimeType: "audio/wav",
              language,
              signal: controller.signal,
            }),
          controller.signal,
        );

        if ("error" in result) {
          res.status(503).json({ error: "Live preview unavailable" });
          return;
        }

        if (!controller.signal.aborted && final && session) session.chunks.push(result);
        if (!controller.signal.aborted) {
          res.set("Cache-Control", "no-store").json({ text: result.text, provisional: true });
        }
      } catch {
        if (!controller.signal.aborted) {
          res.status(503).json({ error: "Live preview unavailable" });
        }
      } finally {
        if (locked) locked.busy = false;
        activeRequests.delete(controller);
      }
    },
  );

  // ── Full recording transcription ───────────────────────────────────────────

  app.post(
    "/api/voice/transcribe",
    requireAuthentication,
    express.raw({ type: "audio/*", limit: "16mb" }),
    async (req, res) => {
      const controller = requestController(req, res);
      try {
        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: "Upload a binary audio file" });
          return;
        }

        const filename = decodeURIComponent(req.get("X-Audio-Filename") ?? "voice.webm");
        const language = req.get("X-Audio-Language") || "en";
        if (!/^[a-zA-Z-]{2,8}$/.test(language)) {
          res.status(400).json({ error: "Invalid language" });
          return;
        }

        const liveId = req.get("X-Live-Id");
        const completedLive = liveId
          ? liveSpeech.take(liveId, res.locals.user.id, Number(req.get("X-Live-Count")))
          : undefined;

        const result = await transcribeRecording(
          res.locals.user.id,
          req.body,
          filename,
          req.get("Content-Type") ?? "audio/webm",
          language,
          controller.signal,
          completedLive,
        );

        if (!controller.signal.aborted) res.json(result);
      } catch (error) {
        if (!controller.signal.aborted) {
          res
            .status(error instanceof BusyError ? 429 : 400)
            .json({ error: errorMessage(error) });
        }
      } finally {
        activeRequests.delete(controller);
      }
    },
  );

  // ── Audio cache playback ───────────────────────────────────────────────────
  // Single-use: the audio is removed from cache on first access.

  app.get("/api/voice/audio/:id", requireAuthentication, (req, res) => {
    const audio = audioCache.take(res.locals.user.id, req.params.id);
    if (!audio) {
      res.status(404).json({ error: "Audio expired or unavailable" });
      return;
    }
    res.type("audio/wav").send(audio);
  });

  // ── TTS synthesis ──────────────────────────────────────────────────────────

  app.post("/api/voice/tts", requireAuthentication, async (req, res) => {
    const controller = requestController(req, res);
    try {
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (req.body?.language && !["en", "ms"].includes(req.body.language)) {
        res.status(400).json({ error: "Choose English or Malay" });
        return;
      }
      const result = await synthesize(text, controller.signal, req.body?.language ?? "en");
      if ("error" in result) {
        res.status(503).json({ error: result.error });
        return;
      }
      if (!controller.signal.aborted) res.type("audio/wav").send(result.audioBuffer);
    } catch {
      if (!controller.signal.aborted) res.status(503).json({ error: "Speech unavailable" });
    } finally {
      activeRequests.delete(controller);
    }
  });

  // ── Voice turn (SSE streaming response) ───────────────────────────────────

  app.post("/api/voice/respond", requireAuthentication, async (req, res) => {
    const parsed = voiceRequestSchema.safeParse({
      ...req.body,
      timezone: req.body?.timezone ?? ENV.timezone,
    });
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a valid CRM request, data source and timezone" });
      return;
    }

    const controller = requestController(req, res);
    const signal = controller.signal;
    const user = res.locals.user;
    const requestId = randomUUID();
    const start = performance.now();

    let release: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let preparedSessionId: number | null = null;

    // Helper: write a single SSE event. No-ops if the connection was closed.
    const send = (event: Record<string, unknown>) => {
      if (!signal.aborted && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    try {
      release = await turnPool.acquire(signal);

      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      send({ type: "start", requestId });

      // Keep the connection alive during long LLM inference.
      heartbeat = setInterval(() => {
        if (!signal.aborted) res.write(": heartbeat\n\n");
      }, 15000);

      const turn = await prepareVoiceTurn(user, parsed.data, {
        signal,
        onFirstToken: (ms) => send({ type: "ttft", ms }),
      });
      preparedSessionId = turn.sessionId;

      await Promise.all([
        recordMetric({
          userId: user.id,
          requestId,
          sessionId: turn.sessionId,
          stage: "intent",
          outcome: "ok",
          durationMs: turn.llmMs,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          loadMs: turn.loadMs,
        }),
        recordMetric({
          userId: user.id,
          requestId,
          sessionId: turn.sessionId,
          stage: "retrieval",
          outcome: "ok",
          durationMs: turn.retrievalMs,
        }),
      ]);

      signal.throwIfAborted();

      send({
        type: "response",
        text: turn.text,
        sources: turn.sources,
        choices: turn.choices,
        sessionId: turn.sessionId,
        proposal: turn.proposal,
        warnings: turn.warnings,
        llmMs: turn.llmMs,
        retrievalMs: turn.retrievalMs,
      });

      // Stream TTS audio: the browser plays the first chunk while subsequent
      // chunks are still being synthesized, reducing perceived latency.
      let firstAudioSent = true;
      if (parsed.data.speak) {
        const sentences = splitForFastFirstAudio(turn.text);
        for (const sentence of sentences) {
          signal.throwIfAborted();
          const result = await synthesize(sentence, signal, parsed.data.responseLanguage);
          if ("error" in result) {
            send({ type: "warning", message: result.error });
            break;
          }
          const url = audioCache.put(user.id, result.audioBuffer);
          send({ type: "audio", url, synthesisMs: result.durationMs });
          if (firstAudioSent) {
            firstAudioSent = false;
            await recordMetric({
              userId: user.id,
              requestId,
              sessionId: turn.sessionId,
              stage: "first_audio",
              outcome: "ok",
              durationMs: performance.now() - start,
            });
          }
        }
      }

      await recordMetric({
        userId: user.id,
        requestId,
        sessionId: turn.sessionId,
        stage: "turn",
        outcome: "ok",
        durationMs: performance.now() - start,
      });

      send({ type: "done", totalMs: Math.round(performance.now() - start) });
    } catch (error) {
      await recordMetric({
        userId: user.id,
        requestId,
        sessionId: preparedSessionId,
        stage: "turn",
        outcome: signal.aborted ? "cancelled" : "error",
        durationMs: performance.now() - start,
      });

      if (!signal.aborted) {
        if (res.headersSent) {
          send({ type: "error", message: errorMessage(error) });
        } else {
          res
            .status(error instanceof BusyError ? 429 : 503)
            .json({ error: errorMessage(error) });
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      release?.();
      activeRequests.delete(controller);
      if (!res.writableEnded) res.end();
    }
  });

  // ── Legacy endpoint tombstones ─────────────────────────────────────────────
  // These routes previously exposed ungrounded answers and prompts in URLs.

  app.get(["/api/voice/stream", "/api/voice/speak"], (_req, res) => {
    res.status(410).json({ error: "Use POST /api/voice/respond" });
  });

  // ── tRPC adapter ──────────────────────────────────────────────────────────

  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  // ── Catch-alls ─────────────────────────────────────────────────────────────

  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        error &&
        typeof error === "object" &&
        "status" in error &&
        typeof (error as { status: unknown }).status === "number"
          ? (error as { status: number }).status
          : 500;
      if (!res.headersSent) {
        res.status(status).json({
          error:
            status === 413 ? "Upload exceeds the size limit" : "Request could not be processed",
        });
      }
    },
  );

  return app;
}

// ── Server startup ────────────────────────────────────────────────────────────

export async function startServer() {
  validateEnvironment();

  const app = createApp();
  const server = createServer(app);

  const { setupVite, serveStatic } = await import("./vite");
  if (!ENV.isProduction) await setupVite(app, server);
  else serveStatic(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ENV.port, ENV.host, resolve);
  });

  console.log(`[App] Listening on ${ENV.host}:${ENV.port}. Readiness: /api/health/ready`);

  void warmLLM().catch(() =>
    console.warn("[Voice] Model preload unavailable; check local model configuration"),
  );

  const shutdown = () => {
    for (const controller of activeRequests) controller.abort();
    audioCache.clear();

    // Give in-flight requests 10 s to finish; then force-exit.
    const timer = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10000);
    timer.unref();

    server.close(() => {
      void closeDb().finally(() => {
        clearTimeout(timer);
        process.exit(0);
      });
    });
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return server;
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    const message = error instanceof Error ? error.message : "";
    if (code === "EADDRINUSE") {
      console.error(`[App] Port ${ENV.port} is already in use. Stop the existing CRM server, or choose another PORT.`);
    } else if (message && !/password|secret|token|credential/i.test(message)) {
      console.error(`[App] Startup failed: ${message}`);
    } else {
      console.error("[App] Startup failed. Check DATABASE_URL, APP_ORIGIN and model configuration.");
    }
    process.exitCode = 1;
  });
}
