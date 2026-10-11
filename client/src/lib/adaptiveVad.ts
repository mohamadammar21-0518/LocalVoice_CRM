export type VadUpdate = { speaking: boolean; shouldStop: boolean; threshold: number; endpointMs: number | null };

/** Lightweight local endpoint detector with a noise floor that follows the room. */
export class AdaptiveVad {
  private noiseFloor = 0.008;
  private aboveThresholdFrames = 0;
  private speechStartedAt: number | null = null;
  private lastVoiceAt: number | null = null;

  constructor(private startedAt: number, private silenceMs = 700) {}

  update(rms: number, now: number): VadUpdate {
    const calibrating = now - this.startedAt < 500;
    const threshold = Math.min(0.08, Math.max(0.012, this.noiseFloor * 2.8));
    const voice = rms > threshold;

    if (voice) {
      this.aboveThresholdFrames++;
      if (this.aboveThresholdFrames >= 2 && this.speechStartedAt === null) this.speechStartedAt = now;
      if (this.speechStartedAt !== null) this.lastVoiceAt = now;
    } else {
      this.aboveThresholdFrames = 0;
      if (this.speechStartedAt === null || calibrating) this.noiseFloor = this.noiseFloor * 0.96 + rms * 0.04;
      // Keep speech active through softer syllable endings.
      if (this.speechStartedAt !== null && rms > threshold * 0.65) this.lastVoiceAt = now;
    }

    const endpointMs = this.lastVoiceAt === null ? null : now - this.lastVoiceAt;
    const longEnough = this.speechStartedAt !== null && now - this.speechStartedAt >= 400;
    return { speaking: this.speechStartedAt !== null, shouldStop: longEnough && endpointMs !== null && endpointMs >= this.silenceMs, threshold, endpointMs };
  }
}
