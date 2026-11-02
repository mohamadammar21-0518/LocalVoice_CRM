import { spawn } from "node:child_process";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import dotenv from "dotenv";
import assert from "node:assert/strict";
import { encryptStream, decryptStream } from "./backup";

// Fixed staging-only container/source. No production restore or deletion.
const container = "localvoice-staging-mysql-1";
const source = "localvoice_staging";
const target = `restore_check_${Date.now()}`;
const config = dotenv.parse(await fs.readFile(".env.staging"));
assert.equal(new URL(config.DATABASE_URL).pathname, `/${source}`);
const key = Buffer.from(config.BACKUP_ENCRYPTION_KEY, "base64");
assert.equal(key.length, 32);
function docker(command: string, input = false) {
  const child = spawn("docker", ["exec", ...(input ? ["-i"] : []), container, "sh", "-c", command], { windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  child.stderr?.resume(); // Never echo command errors containing connection details.
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("Docker unavailable")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Staging MySQL operation failed")));
  });
  void done.catch(() => {});
  return { child, done };
}
const mysql = 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root --batch --skip-column-names';
async function query(sql: string) {
  const { child, done } = docker(`${mysql} -e '${sql}'`);
  let result = "";
  for await (const chunk of child.stdout!) result += chunk.toString();
  await done;
  return result.trim();
}
const directory = path.resolve(".localvoice-private", "staging-backups", target);
await fs.mkdir(directory, { recursive: true });
const encrypted = path.join(directory, "database.sql.enc");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "localvoice-staging-recovery-"));
const sqlFile = path.join(temporary, "verified.sql");
try {
  const dump = docker(`MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -u root --single-transaction --no-tablespaces --set-gtid-purged=OFF ${source}`);
  await encryptStream(dump.child.stdout!, encrypted, key);
  await dump.done;
  // Authenticate the entire backup before passing any SQL to MySQL.
  await decryptStream(encrypted, createWriteStream(sqlFile, { flags: "wx", mode: 0o600 }), key);
  await query(`CREATE DATABASE ${target}`);
  const restore = docker(`${mysql} ${target}`, true);
  restore.child.stdout!.resume();
  await pipeline(createReadStream(sqlFile), restore.child.stdin!);
  await restore.done;
  const originalUsers = await query(`SELECT COUNT(*) FROM ${source}.users`);
  const restoredUsers = await query(`SELECT COUNT(*) FROM ${target}.users`);
  assert.equal(restoredUsers, originalUsers);
  assert.ok(Number(restoredUsers) > 0, "Run the staging login check before recovery");
  const originalTables = await query(`SHOW TABLES FROM ${source}`);
  assert.equal(await query(`SHOW TABLES FROM ${target}`), originalTables);
  for (const table of originalTables.split(/\r?\n/)) {
    assert.match(table, /^[A-Za-z0-9_]+$/);
    assert.equal(await query(`SELECT COUNT(*) FROM ${target}.\`${table}\``), await query(`SELECT COUNT(*) FROM ${source}.\`${table}\``), `Row count: ${table}`);
  }
  console.log(JSON.stringify({ encryptedBackup: encrypted, restoredDatabase: target, verifiedTables: originalTables.split(/\r?\n/).length, users: Number(restoredUsers), sourceUnchanged: true, note: "Database-only rehearsal; recording recovery and restored-app login remain separate acceptance checks." }));
} finally {
  await fs.unlink(sqlFile).catch(() => {});
  await fs.rmdir(temporary).catch(() => {});
}
