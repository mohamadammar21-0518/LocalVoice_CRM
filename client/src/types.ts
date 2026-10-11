/**
 * Client-side TypeScript types for the LocalVoice CRM.
 *
 * These mirror the server's Drizzle inferred types but are safe to import
 * from the client because they carry no database driver dependencies.
 */

// ── Core entities ─────────────────────────────────────────────────────────────

export interface Contact {
  id: number;
  userId: number;
  firstName: string;
  lastName: string;
  company: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  hubspotId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Interaction {
  id: number;
  userId: number;
  contactId: number;
  kind: "note" | "call" | "meeting" | "email";
  body: string;
  hubspotId: string | null;
  hubspotSyncStatus: "not_synced" | "synced" | "error";
  occurredAt: Date;
  createdAt: Date;
}

export interface FollowUpTask {
  id: number;
  userId: number;
  contactId: number;
  title: string;
  dueAt: Date;
  status: "open" | "completed";
  hubspotId: string | null;
  hubspotSyncStatus: "not_synced" | "synced" | "error";
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Joined / composite shapes returned by the API ────────────────────────────

export interface TaskWithContact {
  task: FollowUpTask;
  contact: Contact | null;
}

export interface InteractionWithContact {
  interaction: Interaction;
  contact: Contact | null;
}

export interface DashboardData {
  contactCount: number;
  openTaskCount: number;
  overdueCount: number;
  recentInteractions: InteractionWithContact[];
  upcomingTasks: TaskWithContact[];
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: number;
  name: string | null;
  email: string | null;
  role: "user" | "admin";
  loginMethod: string | null;
  lastSignedIn: Date;
  createdAt: Date;
  openId: string;
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface AdminUser {
  id: number;
  name: string | null;
  email: string | null;
  role: "user" | "admin";
  loginMethod: string | null;
  lastSignedIn: Date;
}

// ── Form value shapes ─────────────────────────────────────────────────────────

export interface ContactFormValues {
  firstName: string;
  lastName: string;
  company: string;
  role: string;
  email: string;
  phone: string;
}

export interface ContactEditValues extends ContactFormValues {
  id: number;
}

export interface TaskFormValues {
  contactId: string;
  title: string;
  dueAt: string;
}

export interface TaskEditValues extends TaskFormValues {
  id: number;
}

export interface NewUserFormValues {
  username: string;
  password: string;
  name: string;
  role: "user" | "admin";
}

// ── UI helpers ────────────────────────────────────────────────────────────────

export type TaskFilter = "all" | "open" | "overdue";
export type Tab = "overview" | "contacts" | "tasks" | "voice" | "salesforce" | "admin";
