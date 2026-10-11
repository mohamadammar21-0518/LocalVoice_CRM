import { randomUUID } from "node:crypto";
import type { TranscriptionResponse } from "./_core/voiceTranscription";

type Session = { owner: number; expires: number; chunks: TranscriptionResponse[]; busy: boolean; frame: number; vocabulary: string[]; engine?: "vosk" };

function editDistance(left: string, right: string) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
}

export function correctCrmVocabulary(text: string, vocabulary: string[]) {
  if (!text || !vocabulary.length || !/\b(find|search|contact|tasks?|notes?|follow.?ups?|cari|kenalan|tugasan|nota|susulan)\b/i.test(text)) return { text, match: null as string | null };
  const words = text.split(/\s+/);
  let best: { start: number; count: number; value: string; score: number } | null = null;
  for (const value of vocabulary) {
    const target = value.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (target.length < 3) continue;
    const targetWords = target.split(/\s+/).length;
    for (const count of [targetWords - 1, targetWords, targetWords + 1].filter(size => size > 0)) {
      for (let start = 0; start + count <= words.length; start++) {
        const candidate = words.slice(start, start + count).join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, "");
        const score = editDistance(candidate, target) / Math.max(candidate.length, target.length);
        if (score <= 0.34 && (!best || score < best.score)) best = { start, count, value, score };
      }
    }
  }
  if (!best) return { text, match: null as string | null };
  return { text: [...words.slice(0, best.start), best.value, ...words.slice(best.start + best.count)].join(" "), match: best.value };
}
/** Ephemeral, owner-bound speech only. Recordings are saved by the normal upload route. */
export class LiveSpeechStore {
  private sessions = new Map<string, Session>();
  start(owner: number, vocabulary: string[] = []) {
    for (const [id, session] of this.sessions) {
      if (session.expires < Date.now() || session.owner === owner && !session.busy) this.sessions.delete(id);
    }
    if (this.sessions.size >= 64) throw new Error("Live speech capacity reached");
    const id = randomUUID();
    this.sessions.set(id, { owner, expires: Date.now() + 180000, chunks: [], busy: false, frame: 0, vocabulary: vocabulary.slice(0, 100) });
    return id;
  }
  get(id: string, owner: number) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.expires < Date.now()) return;
    return session;
  }
  delete(id: string, owner: number) {
    if (!this.get(id, owner)) return false;
    return this.sessions.delete(id);
  }
  take(id: string, owner: number, count: number): TranscriptionResponse | undefined {
    const session = this.get(id, owner);
    if (!session || session.busy || !count || session.chunks.length !== count) return;
    this.sessions.delete(id);
    const text = session.chunks.map(chunk => chunk.text.trim()).filter(Boolean).join(" ");
    if (!text) return;
    return { ...session.chunks[0], text, segments: [],
      duration: session.chunks.reduce((sum, chunk) => sum + chunk.duration, 0), timingMs: undefined };
  }
}
export const liveSpeech = new LiveSpeechStore();
