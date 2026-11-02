import { afterEach, describe, expect, it, vi } from "vitest";
import { openCallMicrophone } from "./callCapture";

afterEach(() => vi.unstubAllGlobals());
describe("continuous call microphone", () => {
  it("keeps one microphone across utterances, detects new speech, mutes and releases tracks", async () => {
    let port: { onmessage?: (event: { data: unknown }) => void };
    const track = { stop: vi.fn(), enabled: true, onended: null };
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", class {
      destination = {}; audioWorklet = { addModule: async () => {} };
      resume = async () => {}; close = async () => {};
      createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    });
    vi.stubGlobal("AudioWorkletNode", class { port = port = {}; connect() {} disconnect() {} });
    const start = vi.fn(), segment = vi.fn();
    const capture = await openCallMicrophone({ language: "ms", onStart: start, onPartial: vi.fn(), onUtterance: segment, onError: vi.fn() });
    const frame = (energy: number) => port.onmessage?.({ data: { audio: new Float32Array(1600).fill(energy), frameMs: 100 } });
    const say = () => { for (let i = 0; i < 8; i++) frame(0.1); for (let i = 0; i < 12; i++) frame(0); };
    for (let i = 0; i < 20; i++) frame(0);
    expect(start).not.toHaveBeenCalled();
    say(); say();
    expect(start).toHaveBeenCalledTimes(2); expect(segment).toHaveBeenCalledTimes(2);
    const recorded = await segment.mock.calls[0][0]; expect(recorded.audio.size).toBeGreaterThan(44);
    expect(getUserMedia).toHaveBeenCalledTimes(1); expect(track.stop).not.toHaveBeenCalled();
    capture.mute(true); say(); expect(start).toHaveBeenCalledTimes(2); expect(track.enabled).toBe(false);
    capture.mute(false); say(); expect(start).toHaveBeenCalledTimes(3);
    capture.close(); say(); expect(start).toHaveBeenCalledTimes(3); expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
