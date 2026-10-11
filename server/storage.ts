/**
 * Local filesystem storage — replaces S3/Forge cloud storage.
 *
 * Audio recordings are saved to `./uploads/` (configurable via LOCAL_STORAGE_PATH).
 * Files are served at `/uploads/<key>` after authentication and owner checks.
 *
 * No cloud credentials required.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ENV } from "./_core/env";

function getStorageDir(): string {
  const dir = path.resolve(ENV.localStoragePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeKey(key: string): string {
  // Replace path separators to keep everything in one flat folder per user prefix
  return key.replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function appendHashSuffix(key: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = key.lastIndexOf(".");
  if (lastDot === -1) return `${key}_${hash}`;
  return `${key.slice(0, lastDot)}_${hash}${key.slice(lastDot)}`;
}

/**
 * Save a file to local disk.
 * Returns a key (relative filename) and a URL path for serving.
 */
export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const storageDir = getStorageDir();
  const key = appendHashSuffix(sanitizeKey(relKey));
  const filePath = path.join(storageDir, key);

  // Ensure subdirectory exists (in case key has a prefix like "1-recordings_...")
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const buffer =
    typeof data === "string"
      ? Buffer.from(data, "utf-8")
      : Buffer.from(data as Uint8Array);

  await fs.promises.writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });

  return { key, url: `/uploads/${key}` };
}

/**
 * Get the URL for an already-saved file.
 */
export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = sanitizeKey(relKey);
  return { key, url: `/uploads/${key}` };
}

/**
 * Return the absolute local filesystem path for a key.
 * Used by the transcription layer to read the file directly.
 */
export function storageLocalPath(key: string): string {
  return path.join(getStorageDir(), sanitizeKey(key));
}

export async function storageDelete(key: string) {
  const filePath = storageLocalPath(key);
  await fs.promises.unlink(filePath).catch(error => { if (error.code !== "ENOENT") throw error; });
}

/**
 * "Signed URL" for local storage is just the same static URL — no expiry needed.
 * Returns the local filesystem path so the transcription service can read bytes directly.
 */
export async function storageGetSignedUrl(relKey: string): Promise<string> {
  return storageLocalPath(relKey);
}
