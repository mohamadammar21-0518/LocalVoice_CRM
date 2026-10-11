import "dotenv/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import path from "node:path";
import os from "node:os";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { pathToFileURL } from "node:url";

const MAGIC = Buffer.from("LVCRM01");
function encryptionKey() {
  const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be a base64 encoded 32-byte key");
  return key;
}
export async function encryptStream(input: Readable, output: string, key: Buffer) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  const handle = await fs.open(output, "wx", 0o600);
  try {
    let position = 0;
    const write = async (bytes: Buffer) => {
      let offset = 0;
      while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, position); offset += result.bytesWritten; position += result.bytesWritten; }
    };
    await write(Buffer.concat([MAGIC, nonce]));
    await pipeline(input, createGzip(), cipher, new Writable({ write(chunk, _encoding, done) { void write(Buffer.from(chunk)).then(() => done(), done); } }));
    await write(cipher.getAuthTag());
    await handle.sync();
  } catch (error) { await handle.close(); await fs.unlink(output).catch(() => {}); throw error; }
  await handle.close();
}
export async function decryptStream(input: string, output: Writable, key: Buffer) {
  const handle = await fs.open(input, "r"), stats = await handle.stat();
  try {
    if (stats.size < MAGIC.length + 28) throw new Error("Invalid backup");
    const header = Buffer.alloc(MAGIC.length + 12), tag = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0); await handle.read(tag, 0, 16, stats.size - 16);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unsupported backup format");
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length)); decipher.setAuthTag(tag);
    await pipeline(createReadStream(input, { start: header.length, end: stats.size - 17 }), decipher, createGunzip(), output);
  } finally { await handle.close(); }
}
function databaseConfig(url: string) {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (parsed.protocol !== "mysql:" || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Use a mysql URL with a simple database name");
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  return { name, content: `[client]\nhost=${quote(parsed.hostname)}\nport=${parsed.port || "3306"}\nuser=${quote(decodeURIComponent(parsed.username))}\npassword=${quote(decodeURIComponent(parsed.password))}\n` };
}
async function privateConfig(url: string, directory: string) {
  const config = databaseConfig(url), filename = path.join(directory, "mysql.cnf");
  await fs.writeFile(filename, config.content, { mode: 0o600 });
  return { name: config.name, filename };
}
function commandCompletion(process: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => { process.once("error", () => reject(new Error("MySQL command unavailable; set MYSQLDUMP_PATH or MYSQL_PATH"))); process.once("exit", code => code === 0 ? resolve() : reject(new Error("MySQL command failed; check access and CLI version"))); });
}
async function backup(output: string) {
  if (!process.argv.includes("--quiesced")) throw new Error("Stop application writes and retention first, then pass --quiesced for a consistent database/audio backup");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const key = encryptionKey(), temporary = await fs.mkdtemp(path.join(os.tmpdir(), "localvoice-backup-"));
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length) throw new Error("Backup directory must be empty; existing backups are never overwritten");
  const database = path.join(output, "database.sql.enc"), audio = path.join(output, "recordings.jsonl.enc");
  try {
    const config = await privateConfig(process.env.DATABASE_URL, temporary);
    const dump = spawn(process.env.MYSQLDUMP_PATH || "mysqldump", [`--defaults-extra-file=${config.filename}`, "--single-transaction", "--skip-add-drop-table", "--no-tablespaces", "--hex-blob", config.name], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const done = commandCompletion(dump); void done.catch(() => {});
    try { await encryptStream(dump.stdout!, database, key); await done; }
    catch (error) { dump.kill(); throw error; }
    const directory = path.resolve(process.env.LOCAL_STORAGE_PATH ?? "uploads");
    async function* recordingLines() {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const filename = path.join(directory, entry.name);
        const stat = await fs.stat(filename);
        if (stat.size > 16 * 1024 * 1024) throw new Error("Recording exceeds backup size limit");
        yield JSON.stringify({ key: entry.name, audio: (await fs.readFile(filename)).toString("base64") }) + "\n";
      }
    }
    await encryptStream(Readable.from(recordingLines()), audio, key);
    console.log(`Encrypted database and recordings backup saved in ${path.resolve(output)}. Keep its encryption key separately.`);
  } catch (error) { await Promise.all([database, audio].map(file => fs.unlink(file).catch(() => {}))); throw error; }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
async function verify(directory: string) {
  for (const file of ["database.sql.enc", "recordings.jsonl.enc"]) await decryptStream(path.join(directory, file), new Writable({ write(_chunk, _encoding, callback) { callback(); } }), encryptionKey());
  console.log("Both backup artifacts decrypted and passed authentication. A restore rehearsal is still required to verify database recovery.");
}
async function restore(directory: string, audioDirectory: string) {
  const url = process.env.RESTORE_DATABASE_URL;
  if (!url || !process.env.DATABASE_URL || !process.argv.includes("--confirm-empty-target")) throw new Error("Set RESTORE_DATABASE_URL and pass --confirm-empty-target. Restore only to a separate empty database and empty audio directory.");
  const source = new URL(process.env.DATABASE_URL), target = new URL(url);
  if (source.hostname === target.hostname && (source.port || "3306") === (target.port || "3306") && source.pathname === target.pathname) throw new Error("Restore target must differ from the current CRM database");
  const connection = await mysql.createConnection(url);
  try {
    const [tables] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
    if (tables.length) throw new Error("Restore target database must be empty");
  } finally { await connection.end(); }
  const audioTarget = path.resolve(audioDirectory);
  if (audioTarget === path.resolve(process.env.LOCAL_STORAGE_PATH ?? "uploads")) throw new Error("Restore audio directory must differ from the current recordings directory");
  await fs.mkdir(audioTarget, { recursive: true });
  if ((await fs.readdir(audioTarget)).length) throw new Error("Restore audio directory must be empty");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "localvoice-restore-"));
  try {
    // Authenticate ALL content before executing SQL or extracting recordings.
    const sql = path.join(temporary, "database.sql"), audio = path.join(temporary, "audio.jsonl");
    await decryptStream(path.join(directory, "database.sql.enc"), createWriteStream(sql, { flags: "wx", mode: 0o600 }), encryptionKey());
    await decryptStream(path.join(directory, "recordings.jsonl.enc"), createWriteStream(audio, { flags: "wx", mode: 0o600 }), encryptionKey());
    const config = await privateConfig(url, temporary);
    const client = spawn(process.env.MYSQL_PATH || "mysql", [`--defaults-extra-file=${config.filename}`, config.name], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const done = commandCompletion(client); void done.catch(() => {});
    await pipeline(createReadStream(sql), client.stdin!); await done;
    let buffer = "";
    for await (const chunk of createReadStream(audio, { encoding: "utf8" })) {
      buffer += chunk;
      if (buffer.length > 24 * 1024 * 1024) throw new Error("Invalid recording backup frame");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const record = JSON.parse(line) as { key: string; audio: string };
        if (!/^[a-zA-Z0-9._-]+$/.test(record.key) || record.key === "." || record.key === ".." || typeof record.audio !== "string") throw new Error("Unsafe recording path in backup");
        const bytes = Buffer.from(record.audio, "base64");
        if (bytes.length > 16 * 1024 * 1024) throw new Error("Recording exceeds size limit");
        await fs.writeFile(path.join(audioTarget, record.key), bytes, { flag: "wx", mode: 0o600 });
      }
    }
    const check = await mysql.createConnection(url);
    try {
      const [missing] = await check.query<RowDataPacket[]>("SELECT storageKey FROM recordings");
      for (const row of missing) await fs.access(path.join(audioTarget, String(row.storageKey)));
      await check.query("SELECT id FROM users LIMIT 1");
      await check.query("SELECT id FROM voiceSessions LIMIT 1");
      console.log(`Restore completed in the separate target. ${missing.length} database recording references have files. Point a staging app at it and verify login and CRM reads before production recovery.`);
    } finally { await check.end(); }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory, audioDirectory] = process.argv.slice(2);
  if (!mode || !directory) throw new Error("Usage: backup.ts backup|verify|restore BACKUP_DIRECTORY [RESTORE_AUDIO_DIRECTORY]");
  void (mode === "backup" ? backup(directory) : mode === "verify" ? verify(directory) : mode === "restore" && audioDirectory ? restore(directory, audioDirectory) : Promise.reject(new Error("Invalid backup command"))).catch(() => { console.error("Backup operation failed. Check the key, directory, MySQL CLI and empty restore target. Incomplete restore targets must be inspected before retrying."); process.exitCode = 1; });
}
