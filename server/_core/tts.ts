import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ENV } from "./env";
import { WorkPool } from "./workPool";

export type TTSResult = { audioBuffer: Buffer; durationMs: number; text: string };
export type TTSError = { error: string; details?: string };
export const ttsPool = new WorkPool(1, ENV.queueLimit, ENV.queueTimeoutMs);

export function splitIntoSentences(text: string) {
  return text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(value => value.trim()).filter(Boolean) ?? [text.trim()];
}
/** Keep the first spoken clause short so playback can begin while later text synthesizes. */
export function splitForFastFirstAudio(text: string) {
  const trimmed = text.trim();
  if (trimmed.length <= 90) return trimmed ? [trimmed] : [];
  const early = trimmed.slice(0, 91);
  const punctuation = [...early.matchAll(/[,;:!?\.](?=\s)/g)].find(match => match.index! >= 24);
  let end = punctuation ? punctuation.index! + 1 : early.lastIndexOf(" ");
  if (end < 40) end = 90;
  return [trimmed.slice(0, end).trim(), ...splitIntoSentences(trimmed.slice(end).trim()).flatMap(sentence => {
    const chunks: string[] = [];
    let rest = sentence;
    while (rest.length > 180) { const at = Math.max(90, rest.slice(0, 181).lastIndexOf(" ")); chunks.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim(); }
    if (rest) chunks.push(rest);
    return chunks;
  })];
}
export function createSentenceSplitter() {
  let buffer = "";
  return {
    feed(token: string): string | null {
      buffer += token;
      const match = /[.!?](?:["']?)(?=\s|$)/.exec(buffer);
      if (!match) return null;
      const end = match.index + match[0].length;
      const sentence = buffer.slice(0, end).trim(); buffer = buffer.slice(end).trimStart();
      return sentence || null;
    },
    flush(): string | null { const rest = buffer.trim(); buffer = ""; return rest || null; },
  };
}
export async function synthesize(text: string, signal?: AbortSignal, language: "en" | "ms" = "en"): Promise<TTSResult | TTSError> {
  if (!text.trim() || text.length > 2000) return { error: "Speech text must contain 1 to 2000 characters" };
  const start = performance.now();
  const timed = AbortSignal.any([AbortSignal.timeout(ENV.ttsTimeoutMs), ...(signal ? [signal] : [])]);
  try {
    return await ttsPool.run(async () => {
      const audioBuffer = ENV.ttsMode === "server" ? await serverSpeech(text, timed, language) : language === "ms" ? await Promise.reject(new Error("Malay speech requires the persistent service")) : await cliSpeech(text, timed);
      return { audioBuffer, text, durationMs: Math.round(performance.now() - start) };
    }, timed);
  } catch { if (signal?.aborted) signal.throwIfAborted(); return { error: "Speech service unavailable. The text response is still available." }; }
}
async function serverSpeech(text: string, signal: AbortSignal, language: "en" | "ms") {
  const response = await fetch(`${ENV.ttsServerUrl.replace(/\/$/, "")}/synthesize`, { method: "POST", signal, headers: { "Content-Type": "application/json", "X-Service-Token": process.env.VOICE_SERVICE_TOKEN ?? "" }, body: JSON.stringify({ text, language }) });
  if (!response.ok || !response.headers.get("content-type")?.includes("audio/wav")) throw new Error("Invalid speech response");
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 44 || audio.length > 8 * 1024 * 1024) throw new Error("Invalid speech audio size");
  return audio;
}
async function cliSpeech(text: string, signal: AbortSignal): Promise<Buffer> {
  const outPath = path.join(os.tmpdir(), `localvoice-piper-${randomUUID()}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ENV.piperPath, ["--model", ENV.piperVoice, "--output_file", outPath], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, signal });
      proc.on("error", reject);
      proc.on("close", code => code === 0 ? resolve() : reject(new Error("Speech synthesis failed")));
      proc.stdin.on("error", () => {});
      proc.stdin.end(text + "\n");
    });
    return await fs.readFile(outPath);
  } finally { await fs.unlink(outPath).catch(() => {}); }
}
export async function* synthesizeStream(tokens: AsyncGenerator<string>) {
  const splitter = createSentenceSplitter();
  for await (const token of tokens) {
    const sentence = splitter.feed(token);
    if (sentence) { const result = await synthesize(sentence); if ("audioBuffer" in result) yield { audio: result.audioBuffer, text: sentence, durationMs: result.durationMs }; }
  }
  const last = splitter.flush();
  if (last) { const result = await synthesize(last); if ("audioBuffer" in result) yield { audio: result.audioBuffer, text: last, durationMs: result.durationMs }; }
}
