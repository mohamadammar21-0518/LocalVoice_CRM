import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "./_core/voiceTranscription";
import { ENV } from "./_core/env";

const initialMode = ENV.whisperMode;
afterEach(() => {
  ENV.whisperMode = initialMode;
  vi.unstubAllGlobals();
});
describe("speech transport cancellation and limits", () => {
  it("does not turn cancellation into a retryable service error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      transcribeAudio({
        audioBuffer: Buffer.from("audio"),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("classifies a model timeout as non-retryable instead of doubling inference time", async () => {
    ENV.whisperMode = "fastapi";
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await transcribeAudio({ audioBuffer: Buffer.from("audio") })
    ).toMatchObject({ code: "TRANSCRIPTION_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("refuses remote audio URLs before making any network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await transcribeAudio({ audioUrl: "http://127.0.0.1/private" })
    ).toMatchObject({ code: "INVALID_FORMAT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
