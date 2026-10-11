import { ENV } from "./env";
import { checkDatabase } from "../db";
import { llmPool } from "./llm";
import { ttsPool } from "./tts";
import { sttPool } from "../voiceRecording";

let cached: { checkedAt: number; ready: boolean; services: Record<string, boolean> } | null = null;
export async function checkReadiness(force = false) {
  if (!force && cached && Date.now() - cached.checkedAt < 5000) return cached;
  const probe = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { "X-Service-Token": process.env.VOICE_SERVICE_TOKEN ?? "" } });
    if (!response.ok) throw new Error("Not ready");
    const body = await response.json();
    if (body.ok === false) throw new Error("Not ready");
    return true;
  };
  const checks = await Promise.allSettled([
    checkDatabase(),
    fetch(`${ENV.ollamaBaseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) }).then(async response => {
      if (!response.ok) throw new Error("Not ready");
      const value = await response.json() as { models: { name: string }[] };
      if (!value.models.some(model => model.name === ENV.ollamaModel || model.name === `${ENV.ollamaModel}:latest`)) throw new Error("Configured model is not installed");
      return true;
    }),
    ENV.whisperMode === "fastapi" ? probe(`${ENV.whisperServerUrl}/health`) : fetch(ENV.whisperBaseUrl, { signal: AbortSignal.timeout(3000) }).then(response => { if (response.status >= 500) throw new Error("Not ready"); return true; }),
    ENV.ttsMode === "server" ? probe(`${ENV.ttsServerUrl}/health`) : import("node:fs/promises").then(async fs => { await Promise.all([fs.access(ENV.piperPath), fs.access(ENV.piperVoice)]); return true; }),
  ]);
  const services = Object.fromEntries(["database", "llm", "stt", "tts"].map((name, index) => [name, checks[index].status === "fulfilled"]));
  cached = { checkedAt: Date.now(), ready: Object.values(services).every(Boolean), services };
  return cached;
}
export function poolStatus() { return { llm: llmPool.status, stt: sttPool.status, tts: ttsPool.status }; }
