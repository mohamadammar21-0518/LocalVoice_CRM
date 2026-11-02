import { pcmWav } from "./liveTranscription";

type Frame = { audio: Float32Array; frameMs: number };
export type CallUtterance = { audio: Blob; live?: { id: string; count: number }; text?: string; confidence?: number };

/** One microphone for the entire call. Silence ends a turn, never the call. */
export async function openCallMicrophone(options: {
  language: "en" | "ms";
  onStart: () => void;
  onPartial: (text: string) => void;
  onUtterance: (utterance: Promise<CallUtterance>) => void;
  onError: (message: string) => void;
}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
  } });
  const context = new AudioContext();
  const controller = new AbortController();
  let source: MediaStreamAudioSourceNode | undefined, worklet: AudioWorkletNode | undefined;
  let stopped = false, muted = false;
  let preRoll: Float32Array[] = [], frames: Float32Array[] = [];
  let voiceFrames = 0, silenceMs = 0, elapsedMs = 0, noise = 0.004;
  let decoder: ReturnType<typeof createDecoder> | null = null;
  let previous = Promise.resolve();
  const close = () => {
    if (stopped) return;
    stopped = true; controller.abort(); decoder?.cancel();
    if (worklet) worklet.port.onmessage = null;
    source?.disconnect(); worklet?.disconnect();
    stream.getTracks().forEach(t => t.stop()); void context.close();
  };
  function finish() {
    if (!frames.length) return;
    const captured = frames; const current = decoder;
    frames = []; decoder = null; elapsedMs = 0; silenceMs = 0; voiceFrames = 0; preRoll = [];
    const pending = (async () => {
      const decoded = await current?.finish();
      return { audio: pcmWav(join(captured), 16000), ...decoded };
    })();
    previous = pending.then(() => {}, () => {});
    options.onUtterance(pending);
  }
  try {
    await context.audioWorklet.addModule("/live-pcm-worklet.js?v=2");
    await context.resume();
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, "live-pcm", { processorOptions: { targetSampleRate: 16000, frameMs: 100 } });
    source.connect(worklet); worklet.connect(context.destination);
    worklet.port.onmessage = ({ data }: MessageEvent<Frame>) => {
      if (stopped || muted || !data.audio) return;
      const { audio, frameMs } = data;
      let energy = 0; for (const sample of audio) energy += sample * sample;
      const rms = Math.sqrt(energy / audio.length);
      const threshold = Math.max(0.012, Math.min(0.065, noise * 3));
      const speaking = rms > threshold;
      if (!frames.length) {
        preRoll.push(audio); if (preRoll.length > 6) preRoll.shift();
        if (!speaking) noise = noise * 0.97 + rms * 0.03;
        voiceFrames = speaking ? voiceFrames + 1 : 0;
        if (voiceFrames < 2) return;
        options.onStart();
        frames = [...preRoll]; preRoll = []; elapsedMs = frames.length * frameMs;
        decoder = options.language === "en" ? createDecoder(previous, controller.signal, options.onPartial) : null;
        for (const item of frames) decoder?.append(item);
      } else {
        frames.push(audio); decoder?.append(audio); elapsedMs += frameMs;
      }
      silenceMs = speaking || rms > threshold * 0.7 ? 0 : silenceMs + frameMs;
      if (silenceMs >= 1000) finish();
      if (elapsedMs >= 110_000) {
        // Preserve a long request intact; do not silently execute cut-off speech.
        finish(); options.onError("Please pause between requests. This turn reached the recording limit.");
      }
    };
    stream.getAudioTracks()[0].onended = () => { if (!stopped) { options.onError("Microphone disconnected. End the call and reconnect it."); close(); } };
    return {
      close,
      mute(value: boolean) {
        muted = value;
        stream.getAudioTracks().forEach(track => { track.enabled = !value; });
        if (value) { decoder?.cancel(); decoder = null; frames = []; preRoll = []; voiceFrames = 0; silenceMs = 0; elapsedMs = 0; }
      },
    };
  } catch (error) { close(); throw error; }
}

function join(frames: Float32Array[]) {
  const result = new Float32Array(frames.reduce((sum, f) => sum + f.length, 0));
  let offset = 0; for (const frame of frames) { result.set(frame, offset); offset += frame.length; }
  return result;
}

/** Bounded streaming decoder, with lossless PCM fallback when streaming fails. */
function createDecoder(previous: Promise<void>, signal: AbortSignal, onPartial: (text: string) => void) {
  let id: string | undefined, sequence = 0, failed = false, cancelled = false;
  let text = "", confidence: number | undefined;
  let buffer: Float32Array[] = [], queued = 0;
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  const cancel = () => {
    cancelled = true; local.abort();
    if (id) void fetch(`/api/voice/live/${id}`, { method: "DELETE", keepalive: true }).catch(() => {});
  };
  let chain = previous.then(async () => {
    const result = await fetch("/api/voice/live/start", { method: "POST", signal: combined });
    if (!result.ok) throw new Error("Streaming unavailable");
    id = (await result.json()).id;
  }).catch(() => { failed = true; });
  function send(frames: Float32Array[], final: boolean) {
    const audio = join(frames); queued += audio.length;
    if (queued > 64_000) { failed = true; cancel(); }
    chain = chain.then(async () => {
      if (failed || cancelled) return;
      const response = await fetch("/api/voice/dictate", { method: "POST", signal: AbortSignal.any([combined, AbortSignal.timeout(10000)]),
        headers: { "Content-Type": "audio/wav", "X-Live-Id": id!, "X-Live-Sequence": String(sequence), "X-Live-Final": final ? "1" : "0" }, body: pcmWav(audio, 16000) });
      if (!response.ok) throw new Error("Streaming unavailable");
      const result = await response.json(); sequence++;
      text = result.text ?? ""; confidence = result.confidence;
      if (!combined.aborted) onPartial(text);
    }).catch(() => { failed = true; cancel(); }).finally(() => { queued -= audio.length; });
  }
  return {
    cancel,
    append(frame: Float32Array) { buffer.push(frame); if (buffer.length >= 3) { send(buffer, false); buffer = []; } },
    async finish() {
      send(buffer, true); buffer = []; await chain;
      if (failed || cancelled || !id || signal.aborted) return {};
      return { live: { id, count: 1 }, text, confidence };
    },
  };
}
