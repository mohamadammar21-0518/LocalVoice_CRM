import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkPool, BusyError } from "./_core/workPool";
import { AudioCache } from "./_core/audioCache";
import { civilDate, dueDateInZone, resolveDateExpression, validDateSafe } from "./_core/dates";
import { percentile } from "./metrics";
import { splitIntoSentences } from "./_core/tts";
import { encryptStream, decryptStream } from "../scripts/backup";
import { migrationStatements } from "../scripts/migrate";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { randomBytes } from "node:crypto";

afterEach(() => vi.useRealTimers());
describe("bounded inference admission", () => {
  it("rejects overload and removes cancelled queued work without occupying capacity", async () => {
    const pool = new WorkPool(1, 1, 1000);
    const release = await pool.acquire();
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal);
    await expect(pool.acquire()).rejects.toBeInstanceOf(BusyError);
    controller.abort(); await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(pool.status.queued).toBe(0);
    release(); release(); expect(pool.status.active).toBe(0);
  });
  it("does not leak a permit when work fails", async () => {
    const pool = new WorkPool(1, 2, 1000);
    await expect(pool.run(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(pool.status.active).toBe(0);
    await expect(pool.run(async () => 42)).resolves.toBe(42);
  });
  it("times out queued work and admits the next request", async () => {
    vi.useFakeTimers(); const pool = new WorkPool(1, 1, 100);
    const release = await pool.acquire();
    const waiting = pool.acquire(); const rejected = expect(waiting).rejects.toBeInstanceOf(BusyError);
    await vi.advanceTimersByTimeAsync(101); await rejected; release();
    expect(pool.status).toMatchObject({ active: 0, queued: 0 });
  });
});
describe("owner-scoped speech playback", () => {
  it("does not consume or expose another user's audio", () => {
    const cache = new AudioCache(); const url = cache.put(1, Buffer.from("voice")); const id = url.split("/").at(-1)!;
    expect(cache.take(2, id)).toBeNull(); expect(cache.take(1, id)?.toString()).toBe("voice"); expect(cache.take(1, id)).toBeNull();
  });
  it("expires playback audio and rejects memory overload", () => {
    vi.useFakeTimers(); const cache = new AudioCache(4, 100);
    const id = cache.put(1, Buffer.from("abcd")).split("/").at(-1)!;
    expect(() => cache.put(1, Buffer.from("x"))).toThrow("full");
    vi.advanceTimersByTime(101); expect(cache.take(1, id)).toBeNull(); expect(() => cache.put(1, Buffer.from("x"))).not.toThrow();
  });
});
describe("calendar dates and actual metric samples", () => {
  it("resolves relative dates using the user's civil date", () => {
    const now = new Date("2026-10-07T18:00:00Z");
    expect(civilDate(now, "Asia/Kuala_Lumpur")).toBe("2026-10-08");
    expect(resolveDateExpression("tomorrow", "Asia/Kuala_Lumpur", now)).toBe("2026-10-09");
    expect(resolveDateExpression("next Friday", "Asia/Kuala_Lumpur", now)).toBe("2026-10-09");
    expect(resolveDateExpression("sometime soon", "Asia/Kuala_Lumpur", now)).toBeNull();
    expect(validDateSafe("2026-02-30")).toBe(false);
  });
  it("schedules 09:00 correctly across DST and server timezones", () => {
    expect(dueDateInZone("2026-10-08", "Asia/Kuala_Lumpur").toISOString()).toBe("2026-10-08T01:00:00.000Z");
    expect(dueDateInZone("2026-07-08", "America/New_York").toISOString()).toBe("2026-07-08T13:00:00.000Z");
    expect(dueDateInZone("2026-12-08", "America/New_York").toISOString()).toBe("2026-12-08T14:00:00.000Z");
  });
  it("includes trailing sentence text and computes p95 without dropping slow requests", () => {
    expect(splitIntoSentences("Saved the note. One more detail")).toEqual(["Saved the note.", "One more detail"]);
    expect(percentile([100, 200, 10000], 0.95)).toBe(10000); expect(percentile([], 0.5)).toBeNull();
  });
});
describe("encrypted backup integrity", () => {
  it("round-trips a streamed backup and detects tampering or the wrong key", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "localvoice-backup-test-"));
    const filename = path.join(directory, "test.enc"), key = randomBytes(32);
    try {
      const content = "CREATE TABLE test (id int);\n".repeat(200);
      await encryptStream(Readable.from([content.slice(0, 100), content.slice(100)]), filename, key);
      const chunks: Buffer[] = [];
      await decryptStream(filename, new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), key);
      expect(Buffer.concat(chunks).toString()).toBe(content);
      const discard = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
      await expect(decryptStream(filename, discard(), randomBytes(32))).rejects.toThrow();
      const corrupted = await fs.readFile(filename); corrupted[30] ^= 1; await fs.writeFile(filename, corrupted);
      await expect(decryptStream(filename, discard(), key)).rejects.toThrow();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
it("parses legacy migration files without skipping multiple statements", () => {
  expect(migrationStatements("ALTER TABLE `a` ADD `x` int;--> statement-breakpoint\nALTER TABLE `a` ADD `y` int;\n")).toHaveLength(2);
});
