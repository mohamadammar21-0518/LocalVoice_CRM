import { ENV } from "./env";
import { WorkPool } from "./workPool";

export type Role = "system" | "user" | "assistant";
export type Message = { role: Role; content: string };
export type InvokeParams = {
  messages: Message[]; model?: string; maxTokens?: number; max_tokens?: number;
  responseFormat?: { type: "json_object" | "text" }; response_format?: { type: "json_object" | "text" };
  outputSchema?: { name: string; schema: Record<string, unknown> }; output_schema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal; onFirstToken?: (ms: number) => void;
};
export type InvokeResult = {
  id: string; created: number; model: string;
  choices: { index: number; message: { role: Role; content: string }; finish_reason: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  timing: { totalMs: number; queueMs: number; loadMs: number; firstTokenMs: number | null };
};
export const llmPool = new WorkPool(ENV.llmConcurrency, ENV.queueLimit, ENV.queueTimeoutMs);

export function buildPayload(params: InvokeParams, stream: boolean) {
  const schema = (params.outputSchema ?? params.output_schema)?.schema;
  const json = schema || (params.responseFormat ?? params.response_format)?.type === "json_object";
  return {
    model: params.model ?? ENV.ollamaModel,
    messages: params.messages,
    stream, think: false, keep_alive: ENV.ollamaKeepAlive,
    ...(json ? { format: schema ?? "json" } : {}),
    options: { temperature: 0, num_ctx: 4096, num_predict: params.maxTokens ?? params.max_tokens ?? ENV.llmMaxTokens },
  };
}

// Native API supports JSON schema, residency controls and inference timing.
// Consume the JSON token stream so first-token timing is available for both modes.
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const start = performance.now();
  const signal = AbortSignal.any([AbortSignal.timeout(ENV.llmTimeoutMs), ...(params.signal ? [params.signal] : [])]);
  const release = await llmPool.acquire(signal);
  const queueMs = performance.now() - start;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${ENV.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPayload(params, true)), signal,
    });
    if (!response.ok || !response.body) throw new Error(`Local model service returned HTTP ${response.status}`);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", content = "", firstTokenMs: number | null = null;
    let last: { done?: boolean; done_reason?: string; error?: string; model?: string; message?: { content?: string }; load_duration?: number; prompt_eval_count?: number; eval_count?: number } = {};
    const consume = (line: string) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line) as typeof last;
      if (chunk.error) throw new Error("Local model could not complete the request");
      if (chunk.message?.content) {
        if (firstTokenMs === null) { firstTokenMs = Math.round(performance.now() - start); params.onFirstToken?.(firstTokenMs); }
        content += chunk.message.content;
        if (content.length > 50000) throw new Error("Local model response exceeded the limit");
      }
      last = chunk;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!last.done || last.done_reason === "length") throw new Error("Local model response was incomplete; shorten the request or increase LLM_MAX_TOKENS");
    return {
      id: crypto.randomUUID(), created: Math.floor(Date.now() / 1000), model: last.model ?? ENV.ollamaModel,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: last.done_reason ?? "stop" }],
      usage: { prompt_tokens: last.prompt_eval_count ?? 0, completion_tokens: last.eval_count ?? 0, total_tokens: (last.prompt_eval_count ?? 0) + (last.eval_count ?? 0) },
      timing: { totalMs: Math.round(performance.now() - start), queueMs: Math.round(queueMs), loadMs: Math.round((last.load_duration ?? 0) / 1e6), firstTokenMs },
    };
  } finally { await reader?.cancel().catch(() => {}); release(); }
}

export async function* streamLLM(params: InvokeParams): AsyncGenerator<string> {
  // Compatibility for unused template consumers; grounded voice responses use invokeLLM.
  const result = await invokeLLM(params);
  yield result.choices[0].message.content;
}
export type ModelInfo = { id: string; object: string; created: number; owned_by: string };
export type ModelsResponse = { object: string; data: ModelInfo[] };
export async function listLLMModels(): Promise<ModelsResponse> {
  const response = await fetch(`${ENV.ollamaBaseUrl.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Local model health check failed: ${response.status}`);
  return response.json();
}
export async function warmLLM() {
  const response = await fetch(`${ENV.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(ENV.llmTimeoutMs),
    body: JSON.stringify({ model: ENV.ollamaModel, messages: [], stream: false, keep_alive: ENV.ollamaKeepAlive }),
  });
  if (!response.ok) throw new Error("Could not preload the local model");
  await response.body?.cancel();
}
