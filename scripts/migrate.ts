import "dotenv/config";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function migrationStatements(sql: string) {
  return sql.replace(/--> statement-breakpoint/g, "\n").split(/;\s*(?=\n|$)/).map(value => value.trim()).filter(Boolean);
}
async function exists(connection: Connection, query: string, values: string[]) {
  const [rows] = await connection.execute<RowDataPacket[]>(query, values); return rows.length > 0;
}
export async function inspectStatement(connection: Connection, sql: string) {
  const table = /^(?:CREATE TABLE|ALTER TABLE) `([^`]+)`/.exec(sql)?.[1];
  if (sql.startsWith("CREATE TABLE") && table) return exists(connection, "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [table]);
  const column = /^ALTER TABLE `([^`]+)` ADD `([^`]+)`/.exec(sql);
  if (column) return exists(connection, "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?", [column[1], column[2]]);
  const constraint = /^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)`/.exec(sql);
  if (constraint) return exists(connection, "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=?", [constraint[1], constraint[2]]);
  const index = /^CREATE INDEX `([^`]+)` ON `([^`]+)`/.exec(sql);
  if (index) return exists(connection, "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?", [index[2], index[1]]);
  throw new Error("Unsupported migration statement; review it before applying");
}

async function preflight(connection: Connection, tables: Set<string>) {
  const queries: [string, string[], string][] = [
    ["Contacts with a missing owner", ["contacts", "users"], "SELECT COUNT(*) n FROM contacts c LEFT JOIN users u ON u.id=c.userId WHERE u.id IS NULL"],
    ["Tasks with a missing or different contact owner", ["followUpTasks", "contacts"], "SELECT COUNT(*) n FROM followUpTasks t LEFT JOIN contacts c ON c.id=t.contactId AND c.userId=t.userId WHERE c.id IS NULL"],
    ["Interactions with a missing or different contact owner", ["interactions", "contacts"], "SELECT COUNT(*) n FROM interactions t LEFT JOIN contacts c ON c.id=t.contactId AND c.userId=t.userId WHERE c.id IS NULL"],
    ["Sessions with a missing owner", ["voiceSessions", "users"], "SELECT COUNT(*) n FROM voiceSessions s LEFT JOIN users u ON u.id=s.userId WHERE u.id IS NULL"],
    ["Recordings with a missing owner", ["recordings", "users"], "SELECT COUNT(*) n FROM recordings r LEFT JOIN users u ON u.id=r.userId WHERE u.id IS NULL"],
    ["Recordings linked to a different session owner", ["recordings", "voiceSessions"], "SELECT COUNT(*) n FROM recordings r LEFT JOIN voiceSessions s ON s.id=r.voiceSessionId AND s.userId=r.userId WHERE r.voiceSessionId IS NOT NULL AND s.id IS NULL"],
    ["Duplicate recording keys", ["recordings"], "SELECT COUNT(*) n FROM (SELECT storageKey FROM recordings GROUP BY storageKey HAVING COUNT(*)>1) d"],
  ];
  for (const table of ["contacts", "interactions", "followUpTasks"]) {
    if (tables.has(table) && await exists(connection, "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='hubspotId'", [table])) queries.push([`Duplicate HubSpot IDs in ${table}`, [table], `SELECT COUNT(*) n FROM (SELECT userId,hubspotId FROM \`${table}\` WHERE hubspotId IS NOT NULL GROUP BY userId,hubspotId HAVING COUNT(*)>1) d`]);
  }
  for (const [label, required, query] of queries) {
    if (!required.every(table => tables.has(table))) continue;
    const [rows] = await connection.query<RowDataPacket[]>(query);
    if (Number(rows[0].n) > 0) throw new Error(`${label}: ${rows[0].n}. Repair these records explicitly before migrating; no rows were removed.`);
  }
}

export async function migrateDatabase(url: string, apply = false) {
  const connection = await mysql.createConnection({ uri: url, timezone: "Z" });
  try {
    const [locks] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('localvoice_migration', 10) acquired");
    if (Number(locks[0].acquired) !== 1) throw new Error("Another migration is running");
    const [tableRows] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
    await preflight(connection, new Set(tableRows.map(row => String(row.TABLE_NAME))));
    const directory = path.resolve("drizzle");
    const files = (await fs.readdir(directory)).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
    const statements: { name: string; sql: string; checksum: string }[] = [];
    for (const file of files) migrationStatements(await fs.readFile(path.join(directory, file), "utf8")).forEach((sql, index) => statements.push({ name: `${file}:${index}`, sql, checksum: createHash("sha256").update(sql).digest("hex") }));
    // Ensure composite unique keys exist before adding the owner foreign keys.
    const ordered = [...statements.filter(item => !item.sql.includes("FOREIGN KEY")), ...statements.filter(item => item.sql.includes("FOREIGN KEY"))];
    if (apply) await connection.query("CREATE TABLE IF NOT EXISTS localvoice_migrations (name varchar(250) PRIMARY KEY, checksum char(64) NOT NULL, appliedAt timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    let applied = 0, adopted = 0;
    for (const item of ordered) {
      if (apply) {
        const [previous] = await connection.execute<RowDataPacket[]>("SELECT checksum FROM localvoice_migrations WHERE name=?", [item.name]);
        if (previous[0]) { if (previous[0].checksum !== item.checksum) throw new Error(`Migration changed after application: ${item.name}`); continue; }
      }
      const present = await inspectStatement(connection, item.sql);
      if (present) adopted++; else applied++;
      if (apply) {
        if (!present) await connection.query(item.sql);
        await connection.execute("INSERT INTO localvoice_migrations (name,checksum) VALUES (?,?)", [item.name, item.checksum]);
      }
    }
    // Validate every expected column when adopting an older db:push installation.
    if (apply) {
      const snapshots = (await fs.readdir(path.join(directory, "meta"))).filter(file => /_snapshot\.json$/.test(file)).sort();
      const snapshot = JSON.parse(await fs.readFile(path.join(directory, "meta", snapshots.at(-1)!), "utf8"));
      for (const table of Object.values(snapshot.tables) as { name: string; columns: Record<string, { name: string; type: string; notNull: boolean }> }[]) {
        const [columns] = await connection.execute<RowDataPacket[]>("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [table.name]);
        const normalize = (type: string) => type.toLowerCase().replace(/^int\(\d+\)/, "int");
        for (const expected of Object.values(table.columns)) {
          const column = columns.find(row => row.COLUMN_NAME === expected.name);
          if (!column || normalize(column.COLUMN_TYPE) !== normalize(expected.type) || (column.IS_NULLABLE === "NO") !== expected.notNull) throw new Error(`Incompatible column ${table.name}.${expected.name}; review the existing schema`);
        }
      }
    }
    console.log(`${apply ? "Migration complete" : "Migration preview"}: ${applied} statements ${apply ? "applied" : "needed"}, ${adopted} existing definitions adopted. No CRM rows deleted.`);
    if (!apply) console.log("Stop the application, take a backup, then run pnpm db:migrate --apply.");
  } finally { await connection.query("SELECT RELEASE_LOCK('localvoice_migration')").catch(() => {}); await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  void migrateDatabase(process.env.DATABASE_URL, process.argv.includes("--apply")).catch(error => { console.error(error instanceof Error && !("sql" in error) ? error.message : "Migration failed; check database access and schema compatibility"); process.exitCode = 1; });
}
