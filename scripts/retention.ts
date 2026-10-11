import "dotenv/config";
import { and, eq, lt } from "drizzle-orm";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireDb, recordings, voiceSessions, voiceLatencySamples, voiceMetrics, closeDb } from "../server/db";
import { ENV } from "../server/_core/env";
import { storageDelete } from "../server/storage";

async function run() {
  const apply = process.argv.includes("--apply"), db = await requireDb();
  const cutoff = new Date(Date.now() - ENV.audioRetentionDays * 86400000);
  const old = await db.select().from(recordings).where(lt(recordings.createdAt, cutoff)).limit(1000);
  console.log(`${old.length} expired recordings found in this batch. ${apply ? "Applying retention." : "Preview only; pass --apply to delete expired audio."}`);
  if (apply) {
    for (const recording of old) {
      await storageDelete(recording.storageKey);
      await db.transaction(async tx => {
        await tx.delete(recordings).where(eq(recordings.id, recording.id));
        if (recording.voiceSessionId) await tx.update(voiceSessions).set({ recordingKey: null, recordingUrl: null }).where(and(eq(voiceSessions.id, recording.voiceSessionId), eq(voiceSessions.userId, recording.userId)));
      });
    }
    await db.delete(voiceMetrics).where(lt(voiceMetrics.createdAt, new Date(Date.now() - 90 * 86400000)));
    await db.delete(voiceLatencySamples).where(lt(voiceLatencySamples.createdAt, new Date(Date.now() - 90 * 86400000)));
  }
  const directory = path.resolve(ENV.localStoragePath), known = new Set((await db.select({ key: recordings.storageKey }).from(recordings)).map(row => row.key));
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let orphans = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || known.has(entry.name)) continue;
    const stat = await fs.stat(path.join(directory, entry.name));
    // Keep recent in-progress uploads, and only touch files in the app's recording namespace.
    if (!/^\d+-recordings_/.test(entry.name) || stat.mtime >= cutoff) continue;
    orphans++; if (apply) await storageDelete(entry.name);
  }
  console.log(`${orphans} expired orphan recordings ${apply ? "removed" : "eligible"}. Transcripts, approved actions and audit history are retained.`);
}
void run().catch(() => { console.error("Retention failed. Check storage access and database configuration."); process.exitCode = 1; }).finally(closeDb);
