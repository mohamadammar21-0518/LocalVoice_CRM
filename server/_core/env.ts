export const ENV = {
  // ── App ──────────────────────────────────────────────────────────────────
  appId: process.env.VITE_APP_ID ?? "localvoice-crm",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",

  // ── Local auth (replaces Manus OAuth) ────────────────────────────────────
  // Set LOCAL_ADMIN_USERNAME and LOCAL_ADMIN_PASSWORD in .env to enable
  // password-based login. The system will auto-create this user on first login.
  localAdminUsername: process.env.LOCAL_ADMIN_USERNAME ?? "admin",
  localAdminPassword: process.env.LOCAL_ADMIN_PASSWORD ?? "",

  // ── Ollama (local LLM) ───────────────────────────────────────────────────
  // Ollama exposes an OpenAI-compatible API at http://localhost:11434
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  // Model for CRM proposal generation — must support JSON output.
  // Recommended: "llama3.1", "mistral", "qwen2.5", "phi3"
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1",

  // ── Local Whisper transcription ──────────────────────────────────────────
  // Option A: whisper.cpp HTTP server (recommended) — run: ./server --port 8080
  // Option B: faster-whisper Python server — run: python local_whisper.py
  // Option C: set WHISPER_MODE=ollama to use Ollama's whisper model (slower)
  whisperBaseUrl: process.env.WHISPER_BASE_URL ?? "http://localhost:8080",
  whisperMode: (process.env.WHISPER_MODE ?? "fastapi") as "whisper-cpp" | "faster-whisper" | "fastapi" | "ollama",
  // Persistent FastAPI whisper server URL (whisper_server.py)
  whisperServerUrl: process.env.WHISPER_SERVER_URL ?? "http://localhost:8001",

  // ── Local file storage (replaces S3) ─────────────────────────────────────
  // Audio recordings are saved to this folder instead of S3
  localStoragePath: process.env.LOCAL_STORAGE_PATH ?? "./uploads",

  // ── Piper TTS ────────────────────────────────────────────────────────────────
  // Download from: https://github.com/rhasspy/piper/releases
  // Voice models:  https://huggingface.co/rhasspy/piper-voices
  piperPath: process.env.PIPER_PATH ?? "",
  piperVoice: process.env.PIPER_VOICE ?? "./models/en_US-lessac-medium.onnx",

  // ── HubSpot ───────────────────────────────────────────────────────────────
  get hubspotToken() { return process.env.HUBSPOT_ACCESS_TOKEN ?? ""; },
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  host: process.env.HOST ?? "127.0.0.1",
  port: numberSetting("PORT", 3000),
  appOrigin: process.env.APP_ORIGIN ?? "http://localhost:3000",
  trustProxy: process.env.TRUST_PROXY === "1",
  timezone: process.env.APP_TIMEZONE ?? "Asia/Kuala_Lumpur",
  sessionHours: numberSetting("SESSION_HOURS", 8),
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE ?? "30m",
  llmTimeoutMs: numberSetting("LLM_TIMEOUT_MS", 60000),
  llmMaxTokens: numberSetting("LLM_MAX_TOKENS", 700),
  llmConcurrency: numberSetting("LLM_CONCURRENCY", 1),
  queueLimit: numberSetting("VOICE_QUEUE_LIMIT", 8),
  queueTimeoutMs: numberSetting("VOICE_QUEUE_TIMEOUT_MS", 15000),
  sttTimeoutMs: numberSetting("STT_TIMEOUT_MS", 60000),
  audioRetentionDays: numberSetting("AUDIO_RETENTION_DAYS", 30),
  ttsMode: (process.env.TTS_MODE ?? "server") as "server" | "cli",
  ttsServerUrl: process.env.TTS_SERVER_URL ?? "http://127.0.0.1:8002",
  ttsTimeoutMs: numberSetting("TTS_TIMEOUT_MS", 15000),
  hubspotTimeoutMs: numberSetting("HUBSPOT_TIMEOUT_MS", 15000),
};

function numberSetting(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive number`);
  return value;
}
export function validateEnvironment() {
  if (ENV.cookieSecret.length < 32 || ENV.cookieSecret.startsWith("change-me")) throw new Error("Set JWT_SECRET to at least 32 random characters");
  if (!ENV.databaseUrl) throw new Error("DATABASE_URL is required");
  if (!ENV.localAdminPassword || ["localvoice123", "yourpassword"].includes(ENV.localAdminPassword)) throw new Error("Set a strong LOCAL_ADMIN_PASSWORD before starting the app");
  if (!ENV.localAdminPassword.startsWith("$2") && ENV.localAdminPassword.length < 12) throw new Error("LOCAL_ADMIN_PASSWORD must contain at least 12 characters");
  if (!["server", "cli"].includes(ENV.ttsMode)) throw new Error("TTS_MODE must be server or cli");
  if (!["fastapi", "whisper-cpp", "faster-whisper", "ollama"].includes(ENV.whisperMode)) throw new Error("Unsupported WHISPER_MODE");
  new Intl.DateTimeFormat("en", { timeZone: ENV.timezone });
  const origin = new URL(ENV.appOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("APP_ORIGIN must be an HTTP(S) origin without a path, credentials or query");
  if (!Number.isInteger(ENV.port) || ENV.port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  const salesforceKey = process.env.SALESFORCE_TOKEN_ENCRYPTION_KEY?.trim();
  if (salesforceKey && (Buffer.from(salesforceKey, "base64").length !== 32 || Buffer.from(salesforceKey, "base64").toString("base64") !== salesforceKey)) throw new Error("SALESFORCE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  const localOrigin = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (ENV.isProduction && ENV.host !== "127.0.0.1" && origin.protocol !== "https:" && !localOrigin) throw new Error("Network deployments require an HTTPS APP_ORIGIN");
}
