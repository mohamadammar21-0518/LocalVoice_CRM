import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, index, uniqueIndex, foreignKey } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  passwordHash: varchar("passwordHash", { length: 255 }),
  sessionVersion: int("sessionVersion").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const contacts = mysqlTable("contacts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  firstName: varchar("firstName", { length: 100 }).notNull(),
  lastName: varchar("lastName", { length: 100 }).notNull(),
  company: varchar("company", { length: 160 }),
  role: varchar("role", { length: 160 }),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 60 }),
  hubspotId: varchar("hubspotId", { length: 64 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("contacts_owner_id").on(table.userId, table.id),
  uniqueIndex("contacts_owner_hubspot").on(table.userId, table.hubspotId),
  index("contacts_owner_name").on(table.userId, table.firstName, table.lastName),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "contacts_user_fk" }).onDelete("cascade"),
]);

export const interactions = mysqlTable("interactions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  contactId: int("contactId").notNull(),
  kind: mysqlEnum("kind", ["note", "call", "meeting", "email"]).default("note").notNull(),
  body: text("body").notNull(),
  hubspotId: varchar("hubspotId", { length: 64 }),
  hubspotSyncStatus: mysqlEnum("hubspotSyncStatus", ["not_synced", "synced", "error"]).default("not_synced").notNull(),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("interactions_owner_contact_date").on(table.userId, table.contactId, table.occurredAt),
  uniqueIndex("interactions_owner_hubspot").on(table.userId, table.hubspotId),
  foreignKey({ columns: [table.userId, table.contactId], foreignColumns: [contacts.userId, contacts.id], name: "interactions_contact_owner_fk" }).onDelete("cascade"),
]);

export const followUpTasks = mysqlTable("followUpTasks", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  contactId: int("contactId").notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  dueAt: timestamp("dueAt").notNull(),
  status: mysqlEnum("status", ["open", "completed"]).default("open").notNull(),
  hubspotId: varchar("hubspotId", { length: 64 }),
  hubspotSyncStatus: mysqlEnum("hubspotSyncStatus", ["not_synced", "synced", "error"]).default("not_synced").notNull(),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  index("tasks_owner_status_due").on(table.userId, table.status, table.dueAt),
  index("tasks_owner_contact").on(table.userId, table.contactId),
  uniqueIndex("tasks_owner_hubspot").on(table.userId, table.hubspotId),
  foreignKey({ columns: [table.userId, table.contactId], foreignColumns: [contacts.userId, contacts.id], name: "tasks_contact_owner_fk" }).onDelete("cascade"),
]);

export const voiceSessions = mysqlTable("voiceSessions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  transcript: text("transcript"),
  detectedLanguage: varchar("detectedLanguage", { length: 16 }),
  proposalType: mysqlEnum("proposalType", ["lookup_contact", "add_note", "create_follow_up", "unsupported"]),
  proposalJson: text("proposalJson"),
  proposalVersion: int("proposalVersion").default(0).notNull(),
  confirmedResultJson: text("confirmedResultJson"),
  status: mysqlEnum("status", ["transcribed", "proposed", "confirmed", "rejected"]).default("transcribed").notNull(),
  recordingKey: varchar("recordingKey", { length: 500 }),
  recordingUrl: varchar("recordingUrl", { length: 1000 }),
  // STT latency in ms — logged per session for performance tracking
  sttLatencyMs: int("sttLatencyMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("sessions_owner_id").on(table.userId, table.id),
  index("sessions_owner_created").on(table.userId, table.createdAt),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "sessions_user_fk" }).onDelete("cascade"),
]);

export const recordings = mysqlTable("recordings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  voiceSessionId: int("voiceSessionId"),
  filename: varchar("filename", { length: 255 }).notNull(),
  mimeType: varchar("mimeType", { length: 100 }).notNull(),
  storageKey: varchar("storageKey", { length: 500 }).notNull(),
  storageUrl: varchar("storageUrl", { length: 1000 }).notNull(),
  sizeBytes: int("sizeBytes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("recordings_storage_key").on(table.storageKey),
  index("recordings_owner_created").on(table.userId, table.createdAt),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "recordings_user_fk" }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.voiceSessionId], foreignColumns: [voiceSessions.userId, voiceSessions.id], name: "recordings_session_owner_fk" }).onDelete("cascade"),
]);

export const auditEvents = mysqlTable("auditEvents", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  sessionId: int("sessionId"),
  event: varchar("event", { length: 80 }).notNull(),
  payload: text("payload").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("audit_owner_created").on(table.userId, table.createdAt), foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "audit_user_fk" }).onDelete("cascade")]);

export const voiceMetrics = mysqlTable("voiceMetrics", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  requestId: varchar("requestId", { length: 36 }).notNull(),
  sessionId: int("sessionId"),
  stage: mysqlEnum("stage", ["stt", "intent", "retrieval", "first_audio", "turn", "confirm", "playback"]).notNull(),
  outcome: mysqlEnum("outcome", ["ok", "error", "cancelled"]).notNull(),
  durationMs: int("durationMs").notNull(),
  inputTokens: int("inputTokens").default(0).notNull(),
  outputTokens: int("outputTokens").default(0).notNull(),
  loadMs: int("loadMs").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("metrics_owner_created").on(table.userId, table.createdAt), uniqueIndex("metrics_request_stage").on(table.userId, table.requestId, table.stage), foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "metrics_user_fk" }).onDelete("cascade")]);

export const voiceLatencySamples = mysqlTable("voiceLatencySamples", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  requestId: varchar("requestId", { length: 36 }).notNull(),
  metric: varchar("metric", { length: 48 }).notNull(),
  durationMs: int("durationMs").notNull(),
  language: varchar("language", { length: 8 }).notNull(),
  engine: varchar("engine", { length: 32 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("latency_owner_created").on(table.userId, table.createdAt),
  index("latency_owner_metric").on(table.userId, table.metric),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "latency_user_fk" }).onDelete("cascade"),
]);

export const hubspotSyncJobs = mysqlTable("hubspotSyncJobs", {
  id: int("id").autoincrement().primaryKey(), userId: int("userId").notNull(),
  kind: mysqlEnum("kind", ["contact", "note", "task"]).notNull(), localId: int("localId").notNull(),
  status: mysqlEnum("status", ["running", "succeeded", "failed", "uncertain"]).notNull(),
  remoteId: varchar("remoteId", { length: 64 }), error: varchar("error", { length: 250 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(), updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("hubspot_job_entity").on(table.userId, table.kind, table.localId), foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "hubspot_jobs_user_fk" }).onDelete("cascade")]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
export type FollowUpTask = typeof followUpTasks.$inferSelect;
export type VoiceSession = typeof voiceSessions.$inferSelect;
export type Recording = typeof recordings.$inferSelect;
