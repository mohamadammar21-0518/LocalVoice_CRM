import { and, asc, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { contacts, followUpTasks, interactions, recordings, users, voiceSessions, type InsertUser } from "../drizzle/schema";
import { TRPCError } from "@trpc/server";
import { ENV } from "./_core/env";
import * as bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { auditEvents, voiceLatencySamples, voiceMetrics } from "../drizzle/schema";
import { storageDelete } from "./storage";

let _db: MySql2Database | null = null;
let _pool: mysql.Pool | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    _pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 10, timezone: "Z", enableKeepAlive: true });
    _db = drizzle(_pool);
  }
  return _db;
}
export async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}
export async function closeDb() { await _pool?.end(); _pool = null; _db = null; }
export async function checkDatabase() {
  const db = await requireDb();
  await db.select({ version: users.sessionVersion }).from(users).limit(1);
  await db.select({ version: voiceSessions.proposalVersion, result: voiceSessions.confirmedResultJson }).from(voiceSessions).limit(1);
  await db.select({ id: voiceMetrics.id }).from(voiceMetrics).limit(1);
  await db.select({ id: voiceLatencySamples.id }).from(voiceLatencySamples).limit(1);
  return true;
}
export async function revokeUserSessions(id: number) {
  const db = await requireDb();
  await db.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1` }).where(eq(users.id, id));
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId, name: user.name, email: user.email, loginMethod: user.loginMethod, lastSignedIn: user.lastSignedIn ?? new Date(), role: user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user") };
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: { name: values.name, email: values.email, loginMethod: values.loginMethod, lastSignedIn: values.lastSignedIn, role: values.role } });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb(); if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function searchContacts(userId: number, query = "", limit = 100, offset = 0) {
  const db = await requireDb();
  const pattern = `%${query.trim().replace(/[\\%_]/g, character => `\\${character}`)}%`;
  return db.select().from(contacts).where(and(eq(contacts.userId, userId), query.trim() ? or(like(contacts.firstName, pattern), like(contacts.lastName, pattern), like(contacts.company, pattern), like(contacts.role, pattern), like(contacts.email, pattern), sql`concat(${contacts.firstName}, ' ', ${contacts.lastName}) like ${pattern}`) : undefined)).orderBy(asc(contacts.firstName), asc(contacts.lastName), asc(contacts.id)).limit(Math.min(200, Math.max(1, limit))).offset(offset);
}

export async function getContact(userId: number, id: number) {
  const db = await requireDb();
  const rows = await db.select().from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.id, id))).limit(1); return rows[0];
}

export async function getInteractions(userId: number, contactId?: number, limit = 100, offset = 0) {
  const db = await requireDb();
  return db.select().from(interactions).where(and(eq(interactions.userId, userId), contactId ? eq(interactions.contactId, contactId) : undefined)).orderBy(desc(interactions.occurredAt), desc(interactions.id)).limit(Math.min(limit, 200)).offset(offset);
}

export async function getTasks(userId: number, filter: "all" | "open" | "overdue" = "all", contactId?: number, limit = 100, offset = 0) {
  const db = await requireDb();
  const now = new Date();
  return db.select({ task: followUpTasks, contact: contacts }).from(followUpTasks).leftJoin(contacts, and(eq(followUpTasks.contactId, contacts.id), eq(followUpTasks.userId, contacts.userId))).where(and(eq(followUpTasks.userId, userId), contactId ? eq(followUpTasks.contactId, contactId) : undefined, filter === "open" ? eq(followUpTasks.status, "open") : filter === "overdue" ? and(eq(followUpTasks.status, "open"), lte(followUpTasks.dueAt, now)) : undefined)).orderBy(asc(followUpTasks.dueAt), asc(followUpTasks.id)).limit(Math.min(limit, 200)).offset(offset);
}

export async function getDashboard(userId: number) {
  const db = await requireDb();
  const [contactCount, openTaskCount, overdueCount, recentInteractions, upcomingTasks] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(contacts).where(eq(contacts.userId, userId)),
    db.select({ count: sql<number>`count(*)` }).from(followUpTasks).where(and(eq(followUpTasks.userId, userId), eq(followUpTasks.status, "open"))),
    db.select({ count: sql<number>`count(*)` }).from(followUpTasks).where(and(eq(followUpTasks.userId, userId), eq(followUpTasks.status, "open"), lte(followUpTasks.dueAt, new Date()))),
    db.select({ interaction: interactions, contact: contacts }).from(interactions).leftJoin(contacts, and(eq(interactions.contactId, contacts.id), eq(contacts.userId, userId))).where(eq(interactions.userId, userId)).orderBy(desc(interactions.occurredAt)).limit(5),
    db.select({ task: followUpTasks, contact: contacts }).from(followUpTasks).leftJoin(contacts, and(eq(followUpTasks.contactId, contacts.id), eq(contacts.userId, userId))).where(and(eq(followUpTasks.userId, userId), eq(followUpTasks.status, "open"), gte(followUpTasks.dueAt, new Date()))).orderBy(asc(followUpTasks.dueAt)).limit(5),
  ]);
  return { contactCount: Number(contactCount[0]?.count ?? 0), openTaskCount: Number(openTaskCount[0]?.count ?? 0), overdueCount: Number(overdueCount[0]?.count ?? 0), recentInteractions, upcomingTasks };
}

export async function seedDemoData(userId: number) {
  const db = await getDb(); if (!db) return false;
  const existing = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, userId)).limit(1); if (existing.length) return false;
  const created = await db.insert(contacts).values([
    { userId, firstName: "Maya", lastName: "Chen", company: "Northstar Studio", role: "Creative Director", email: "maya@northstar.studio", phone: "+1 415 555 0142", notes: "Values thoughtful, low-friction collaboration." },
    { userId, firstName: "Jonas", lastName: "Meyer", company: "Field Notes Co.", role: "Founder", email: "jonas@fieldnotes.co", phone: "+49 30 555 0188", notes: "Interested in a lightweight customer workflow." },
    { userId, firstName: "Priya", lastName: "Nair", company: "Lumen Health", role: "Partnerships Lead", email: "priya@lumen.health", phone: "+1 646 555 0136", notes: "Follow up after the product review." },
  ]);
  const rows = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, userId)).orderBy(asc(contacts.id));
  const ids = rows.map(r => r.id); if (ids.length >= 3) {
    await db.insert(interactions).values([{ userId, contactId: ids[0], kind: "meeting", body: "Explored a calmer way to keep client conversations connected to next steps.", occurredAt: new Date(Date.now() - 86400000 * 2) }, { userId, contactId: ids[1], kind: "note", body: "Sent a short overview of the workspace and voice capture flow.", occurredAt: new Date(Date.now() - 86400000) }]);
    await db.insert(followUpTasks).values([{ userId, contactId: ids[0], title: "Send the tailored proposal", dueAt: new Date(Date.now() + 86400000 * 2) }, { userId, contactId: ids[1], title: "Check in about workflow fit", dueAt: new Date(Date.now() - 86400000) }, { userId, contactId: ids[2], title: "Schedule product review follow-up", dueAt: new Date(Date.now() + 86400000 * 5) }]);
  }
  return Boolean(created);
}

export async function getRecording(userId: number, id: number) { const db = await getDb(); if (!db) return undefined; const rows = await db.select().from(recordings).where(and(eq(recordings.userId, userId), eq(recordings.id, id))).limit(1); return rows[0]; }

// ── Multi-user management ─────────────────────────────────────────────────────

export async function listUsers() {
  const db = await getDb(); if (!db) return [];
  return db.select({ id: users.id, name: users.name, email: users.email, role: users.role, loginMethod: users.loginMethod, lastSignedIn: users.lastSignedIn, createdAt: users.createdAt }).from(users).orderBy(asc(users.createdAt));
}

export async function createUser(data: { username: string; password: string; name?: string; role?: "user" | "admin" }): Promise<void> {
  const db = await getDb(); if (!db) throw new Error("DB unavailable");
  const openId = `local_${data.username}`;
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.openId, openId)).limit(1);
  if (existing[0]) throw new TRPCError({ code: "CONFLICT", message: `User "${data.username}" already exists` });
  const passwordHash = await bcrypt.hash(data.password, 12);
  await db.insert(users).values({ openId, name: data.name ?? data.username, email: null, loginMethod: "local", role: data.role ?? "user", lastSignedIn: new Date(), passwordHash } as any);
}

export async function getUserPasswordHash(openId: string): Promise<string | null> {
  const db = await getDb(); if (!db) return null;
  const rows = await db.select({ passwordHash: (users as any).passwordHash }).from(users).where(eq(users.openId, openId)).limit(1);
  return rows[0]?.passwordHash ?? null;
}

export async function deleteUser(id: number): Promise<void> {
  const db = await requireDb();
  const keys = await db.transaction(async tx => {
    const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, "admin")).orderBy(asc(users.id)).for("update");
    if (admins.length === 1 && admins[0].id === id) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot delete the last administrator" });
    const files = await tx.select({ key: recordings.storageKey }).from(recordings).where(eq(recordings.userId, id));
    await tx.delete(users).where(eq(users.id, id));
    return files.map(file => file.key);
  });
  await Promise.all(keys.map(key => storageDelete(key).catch(() => console.warn("[Storage] An orphaned recording needs retention cleanup"))));
}

export async function updateUserRole(id: number, role: "user" | "admin"): Promise<void> {
  const db = await requireDb();
  await db.transaction(async tx => {
    const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, "admin")).orderBy(asc(users.id)).for("update");
    if (role !== "admin" && admins.length === 1 && admins[0].id === id) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot demote the last administrator" });
    await tx.update(users).set({ role, sessionVersion: sql`${users.sessionVersion} + 1` }).where(eq(users.id, id));
  });
}

export { contacts, followUpTasks, interactions, recordings, voiceSessions, users, auditEvents, voiceLatencySamples, voiceMetrics };
