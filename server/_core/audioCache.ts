import { randomUUID } from "node:crypto";
/** Short-lived binary audio, restricted to its owner; never recorded to disk. */
export class AudioCache {
  private items = new Map<string, { userId: number; audio: Buffer; expires: number }>();
  private bytes = 0;
  constructor(private maxBytes = 32 * 1024 * 1024, private ttlMs = 90000) {}
  private sweep() { for (const [id, item] of this.items) if (item.expires <= Date.now()) { this.bytes -= item.audio.length; this.items.delete(id); } }
  put(userId: number, audio: Buffer) {
    this.sweep();
    if (audio.length + this.bytes > this.maxBytes) throw new Error("Speech playback buffer is full");
    const id = randomUUID(); this.items.set(id, { userId, audio, expires: Date.now() + this.ttlMs }); this.bytes += audio.length;
    return `/api/voice/audio/${id}`;
  }
  take(userId: number, id: string) {
    this.sweep(); const item = this.items.get(id);
    if (!item || item.userId !== userId) return null;
    this.items.delete(id); this.bytes -= item.audio.length;
    return item.audio;
  }
  clear() { this.items.clear(); this.bytes = 0; }
}
