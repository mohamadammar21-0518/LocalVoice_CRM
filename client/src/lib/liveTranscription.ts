export type LiveResult = { id: string; count: number };
export type LatencySample = { metric: "partial_render" | "final_transcript" | "frame_duration" | "client_queue" | "model_queue" | "model_inference" | "endpoint_detection"; durationMs: number };
export type LiveTelemetry = { language: string; engine: string; samples: LatencySample[] };
export type LiveCapture = { finish: () => Promise<LiveResult | undefined>; cancel: () => void; telemetry: () => LiveTelemetry };
type WorkletFrame = { audio: Float32Array; inputSampleRate: number; outputSampleRate: number; frameMs: number; sequence: number };
function readFrame(data: Float32Array | WorkletFrame): WorkletFrame {
  return data instanceof Float32Array ? { audio: data, inputSampleRate: 16000, outputSampleRate: 16000, frameMs: data.length / 16, sequence: 0 } : data;
}

/** One inference at a time, provisional revisions within a segment, finalized text across segments. */
export async function startLiveTranscription(stream: MediaStream, language: string,
  onText: (text: string) => void, onUnavailable: () => void): Promise<LiveCapture> {
  if (language === "en") return startEnglishDictation(stream, onText, onUnavailable);
  const context = new AudioContext();
  const controller = new AbortController();
  let stopped = false, ending = false, failed = false, busy = false;
  let sequence = 0, committed = '', voiced = false, silence = 0, lastRequest = 0;
  let samples = new Float32Array(0);
  let source: MediaStreamAudioSourceNode | undefined, node: AudioWorkletNode | undefined;
  let finishPromise: Promise<LiveResult | undefined> | undefined;
  const latencySamples: LatencySample[] = [];
  let flushResolve: (() => void) | undefined;
  const queue: Float32Array[] = [];
  let pending: Promise<void> = Promise.resolve();
  const closeAudio = () => { source?.disconnect(); node?.disconnect(); void context.close().catch(() => {}); };
  const cancel = () => { stopped = true; controller.abort(); closeAudio(); flushResolve?.(); };
  const fail = () => { if (!failed && !stopped) { failed = true; onUnavailable(); cancel(); } };
  try {
    const start = await fetch('/api/voice/live/start', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    if (!start.ok) throw new Error('Live speech unavailable');
    const { id } = await start.json() as { id: string };
    await context.audioWorklet.addModule('/live-pcm-worklet.js?v=2');
    await context.resume();
    source = context.createMediaStreamSource(stream); node = new AudioWorkletNode(context, 'live-pcm', { processorOptions: { targetSampleRate: 16000, frameMs: 250 } });
    source.connect(node); node.connect(context.destination);
    const request = async (audio: Float32Array, final: boolean) => {
      const requestStarted = performance.now();
      const result = await fetch('/api/voice/preview', { method: 'POST', credentials: 'same-origin',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        headers: { 'Content-Type': 'audio/wav', 'X-Live-Id': id, 'X-Live-Sequence': String(sequence),
          'X-Live-Final': final ? '1' : '0', ...(language ? { 'X-Audio-Language': language } : {}) },
        body: pcmWav(audio, 16000) });
      if (result.status === 429 && !final) return;
      if (!result.ok) throw new Error('Live speech unavailable');
      const value = await result.json();
      if (stopped) return;
      if (final) { sequence++; committed = [committed, value.text?.trim()].filter(Boolean).join(' '); }
      onText(final ? committed : [committed, value.text?.trim()].filter(Boolean).join(' '));
      latencySamples.push({ metric: final ? "final_transcript" : "partial_render", durationMs: Math.round(performance.now() - requestStarted) });
    };
    const pump = () => {
      if (busy || stopped || !queue.length) return;
      busy = true;
      pending = (async () => {
        try { while (queue.length && !stopped) await request(queue.shift()!, true); }
        catch { fail(); }
        finally { busy = false; }
      })();
    };
    const finalizeSegment = () => {
      if (voiced && samples.length) queue.push(samples);
      samples = new Float32Array(0); voiced = false; silence = 0;
      if (queue.length > 3) { fail(); return; } // Preserve full audio via MediaRecorder fallback instead of dropping speech.
      pump();
    };
    node.port.onmessage = ({ data }: MessageEvent<Float32Array | WorkletFrame | { flushed: true }>) => {
      if (!(data instanceof Float32Array) && !("audio" in data)) { flushResolve?.(); return; }
      if (stopped) return;
      const frame = readFrame(data as Float32Array | WorkletFrame);
      let energy = 0; for (const sample of frame.audio) energy += sample * sample;
      const speaking = Math.sqrt(energy / frame.audio.length) > 0.015;
      if (speaking) { voiced = true; silence = 0; } else silence += frame.audio.length;
      const merged = new Float32Array(samples.length + frame.audio.length); merged.set(samples); merged.set(frame.audio, samples.length); samples = merged;
      if (!voiced) { samples = samples.slice(-8000); return; } // Half-second pre-roll only during silence.
      if (silence >= 12000 || samples.length >= 128000) { finalizeSegment(); return; }
      if (!ending && !busy && !queue.length && samples.length >= 24000 && performance.now() - lastRequest >= 2500) {
        busy = true; lastRequest = performance.now();
        pending = request(samples.slice(), false).catch(fail).finally(() => { busy = false; pump(); });
      }
    };
    const finish = () => finishPromise ??= (async () => {
      if (stopped) return undefined;
      ending = true;
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { fail(); resolve(); }, 1500);
        flushResolve = () => { clearTimeout(timeout); resolve(); };
        node!.port.postMessage('flush');
      });
      closeAudio();
      if (stopped) return undefined;
      finalizeSegment();
      // A pending preview may start the final queue when it resolves.
      while (!stopped && (busy || queue.length)) { pump(); await pending; }
      stopped = true;
      return !failed && sequence ? { id, count: sequence } : undefined;
    })();
    return { finish, cancel, telemetry: () => ({ language, engine: "faster-whisper", samples: latencySamples.slice(-64) }) };
  } catch (error) { cancel(); throw error; }
}

/** Native streaming decoder: send every frame exactly once and display interim words. */
async function startEnglishDictation(stream: MediaStream, onText: (text: string) => void, onUnavailable: () => void): Promise<LiveCapture> {
  const context = new AudioContext();
  const controller = new AbortController();
  let source: MediaStreamAudioSourceNode | undefined, node: AudioWorkletNode | undefined;
  let stopped = false, busy = false, frame = 0;
  let sessionId: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  let completed: Promise<LiveResult | undefined> | undefined;
  const latencySamples: LatencySample[] = [];
  let inputSampleRate = context.sampleRate;
  let flushed: (() => void) | undefined;
  const queue: { audio: Float32Array; capturedAt: number }[] = [];
  const close = () => { source?.disconnect(); node?.disconnect(); void context.close().catch(() => {}); };
  const cancel = () => {
    if (stopped) return;
    stopped = true; controller.abort(); close(); flushed?.();
    if (sessionId) void fetch(`/api/voice/live/${encodeURIComponent(sessionId)}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
  };
  const fail = () => { if (!stopped) { onUnavailable(); cancel(); } };
  try {
    const started = await fetch('/api/voice/live/start', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    if (!started.ok) throw new Error('Dictation unavailable');
    const { id } = await started.json() as { id: string };
    sessionId = id;
    await context.audioWorklet.addModule('/live-pcm-worklet.js?v=2');
    await context.resume();
    const send = async (audio: Float32Array, final = false, capturedAt = performance.now()) => {
      const clientQueueMs = Math.max(0, performance.now() - capturedAt);
      const response = await fetch('/api/voice/dictate', { method: 'POST', credentials: 'same-origin',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        headers: { 'Content-Type': 'audio/wav', 'X-Live-Id': id, 'X-Live-Sequence': String(frame), 'X-Live-Final': final ? '1' : '0' },
        body: pcmWav(audio, 16000) });
      if (!response.ok) throw new Error('Dictation unavailable');
      const result = await response.json();
      if (!stopped) {
        frame++; onText(result.text ?? '');
        if (audio.length || final) {
          latencySamples.push({ metric: final ? "final_transcript" : "partial_render", durationMs: Math.round(performance.now() - capturedAt) });
          if (!final) {
            latencySamples.push({ metric: "client_queue", durationMs: Math.round(clientQueueMs) });
            latencySamples.push({ metric: "model_queue", durationMs: Math.max(0, Math.round(result.modelQueueMs ?? 0)) });
            latencySamples.push({ metric: "model_inference", durationMs: Math.max(0, Math.round(result.modelInferenceMs ?? 0)) });
          }
        }
      }
    };
    // Check the local decoder before showing Listening, so failure is visible immediately.
    await send(new Float32Array(0));
    const pump = () => {
      if (busy || stopped || !queue.length) return;
      busy = true;
      pending = (async () => {
        try { while (!stopped && queue.length) { const next = queue.shift()!; await send(next.audio, false, next.capturedAt); } }
        catch { fail(); }
        finally { busy = false; }
      })();
    };
    source = context.createMediaStreamSource(stream); node = new AudioWorkletNode(context, 'live-pcm', { processorOptions: { targetSampleRate: 16000, frameMs: 250 } });
    node.port.onmessage = ({ data }: MessageEvent<Float32Array | WorkletFrame | { flushed: true }>) => {
      if (!(data instanceof Float32Array) && !("audio" in data)) { flushed?.(); return; }
      if (stopped) return;
      const workletFrame = readFrame(data as Float32Array | WorkletFrame);
      inputSampleRate = workletFrame.inputSampleRate;
      latencySamples.push({ metric: "frame_duration", durationMs: Math.round(workletFrame.frameMs) });
      queue.push({ audio: workletFrame.audio, capturedAt: performance.now() });
      if (queue.length > 12) { fail(); return; }
      pump();
    };
    source.connect(node); node.connect(context.destination);
    const finish = () => completed ??= (async () => {
      if (stopped) return undefined;
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { fail(); resolve(); }, 1500);
        flushed = () => { clearTimeout(timeout); resolve(); };
        node!.port.postMessage('flush');
      });
      close();
      while (!stopped && (busy || queue.length)) { pump(); await pending; }
      if (stopped) return undefined;
      try { await send(new Float32Array(0), true); }
      catch { fail(); return undefined; }
      stopped = true;
      return { id, count: 1 };
    })();
    return { finish, cancel, telemetry: () => ({ language: "en", engine: `vosk:${inputSampleRate}->16000`, samples: latencySamples.slice(-64) }) };
  } catch (error) { cancel(); throw error; }
}

export function pcmWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  return new Blob([buffer], { type: 'audio/wav' });
}
