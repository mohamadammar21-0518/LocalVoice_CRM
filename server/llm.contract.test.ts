import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPayload, invokeLLM, llmPool } from "./_core/llm";
afterEach(() => vi.unstubAllGlobals());
describe("local inference contract", () => {
  it("sends a schema and token limit through the native Ollama API", () => {
    const schema = { type: "object", properties: { kind: { type: "string" } } };
    const payload = buildPayload({ messages: [{ role: "user", content: "Find Maya" }], outputSchema: { name: "intent", schema }, maxTokens: 80 }, true);
    expect(payload.format).toEqual(schema); expect(payload.options.num_predict).toBe(80); expect(payload.keep_alive).toBeTruthy(); expect(payload.think).toBe(false);
  });
  it("handles split JSON frames, reports timing, and releases its permit", async () => {
    const data = [{ message: { content: '{"kind":' }, done: false }, { message: { content: '"contacts"}' }, done: false }, { done: true, done_reason: "stop", load_duration: 300000000, prompt_eval_count: 4, eval_count: 5 }].map(value => JSON.stringify(value)).join("\n");
    const encoder = new TextEncoder(); vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(data.slice(0, 20))); controller.enqueue(encoder.encode(data.slice(20))); controller.close(); } }))));
    const first = vi.fn(); const result = await invokeLLM({ messages: [{ role: "user", content: "Find Maya" }], onFirstToken: first });
    expect(result.choices[0].message.content).toBe('{"kind":"contacts"}'); expect(first).toHaveBeenCalledTimes(1); expect(result.timing.loadMs).toBe(300); expect(result.usage?.total_tokens).toBe(9); expect(llmPool.status.active).toBe(0);
  });
  it("rejects incomplete output without passing it to action execution", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":{"content":"{partial"},"done":true,"done_reason":"length"}\n')));
    await expect(invokeLLM({ messages: [] })).rejects.toThrow("incomplete"); expect(llmPool.status.active).toBe(0);
  });
});
