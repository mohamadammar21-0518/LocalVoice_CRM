import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveSpeechStore } from "./liveSpeech";
import { startLiveTranscription, pcmWav } from "../client/src/lib/liveTranscription";
import type { TranscriptionResponse } from "./_core/voiceTranscription";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("continuous speech", () => {
  it("only consumes complete transcripts belonging to the current user", () => {
    const store = new LiveSpeechStore(), id = store.start(7);
    store.get(id, 7)!.chunks.push({ text: "Find Maya.", duration: 2 } as TranscriptionResponse);
    expect(store.take(id, 8, 1)).toBeUndefined();
    expect(store.take(id, 7, 2)).toBeUndefined();
    store.get(id, 7)!.busy = true;
    expect(store.take(id, 7, 1)).toBeUndefined();
    store.get(id, 7)!.busy = false;
    expect(store.take(id, 7, 1)?.text).toBe("Find Maya.");
    expect(store.take(id, 7, 1)).toBeUndefined();
  });
  it("expires recordings and keeps each user's sessions separate", () => {
    const store = new LiveSpeechStore(), first = store.start(1), second = store.start(2);
    store.start(1);
    expect(store.get(first, 1)).toBeUndefined();
    expect(store.get(second, 2)).toBeDefined();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 180001);
    expect(store.get(second, 2)).toBeUndefined();
  });
  it("writes a valid mono PCM header with clipped samples", async () => {
    const view = new DataView(await pcmWav(new Float32Array([-2, 0, 2]), 16000).arrayBuffer());
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32767);
    expect(view.getInt16(48, true)).toBe(32767);
  });
  it("flushes final audio, waits for decoding, and preserves text across pauses", async () => {
    let port: { onmessage?: (event: { data: unknown }) => void; postMessage: () => void };
    vi.stubGlobal("AudioContext", class {
      sampleRate = 16000; destination = {};
      audioWorklet = { addModule: async () => {} };
      resume = async () => {}; close = async () => {};
      createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    });
    vi.stubGlobal("AudioWorkletNode", class {
      port = port = { onmessage: undefined, postMessage: () => { port.onmessage?.({ data: { flushed: true } }); } };
      connect() {} disconnect() {}
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/start")) return Response.json({ id: "session" });
      const headers = options.headers as Record<string, string>;
      requests.push(headers["X-Live-Sequence"]);
      return Response.json({ text: requests.length === 1 ? "Find Maya." : "Read her tasks." });
    }));
    const text = vi.fn(), unavailable = vi.fn();
    const capture = await startLiveTranscription({} as MediaStream, "ms", text, unavailable);
    port!.onmessage!({ data: new Float32Array(4000).fill(0.1) });
    port!.onmessage!({ data: new Float32Array(12000) });
    await vi.waitFor(() => expect(text).toHaveBeenCalledWith("Find Maya."));
    port!.onmessage!({ data: new Float32Array(4000).fill(0.1) });
    expect(await capture.finish()).toEqual({ id: "session", count: 2 });
    expect(requests).toEqual(["0", "1"]);
    expect(text).toHaveBeenLastCalledWith("Find Maya. Read her tasks.");
    expect(unavailable).not.toHaveBeenCalled();
    // A failed final segment must fall back rather than submit a partial transcript or hang.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/start")
      ? Response.json({ id: "fallback" }) : new Response("Unavailable", { status: 503 })));
    const fallback = await startLiveTranscription({} as MediaStream, "ms", text, unavailable);
    port!.onmessage!({ data: new Float32Array(4000).fill(0.1) });
    expect(await fallback.finish()).toBeUndefined();
    expect(unavailable).toHaveBeenCalledTimes(1);
    // Native English streaming emits text on an audio frame, without a pause or Stop.
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/start")) return Response.json({ id: "english" });
      expect(url).toBe("/api/voice/dictate");
      const headers = options.headers as Record<string, string>;
      return Response.json({ text: headers["X-Live-Sequence"] === "0" ? "" : headers["X-Live-Final"] === "1" ? "find maya chen" : "find maya" });
    }));
    const english = await startLiveTranscription({} as MediaStream, "en", text, unavailable);
    port!.onmessage!({ data: new Float32Array(4000).fill(0.1) });
    await vi.waitFor(() => expect(text).toHaveBeenLastCalledWith("find maya"));
    expect(await english.finish()).toEqual({ id: "english", count: 1 });
    expect(text).toHaveBeenLastCalledWith("find maya chen");
  });
});
