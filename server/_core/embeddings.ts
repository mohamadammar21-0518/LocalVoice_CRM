/**
 * Semantic contact search using nomic-embed-text via Ollama
 *
 * How it works:
 *  1. Convert query to a vector embedding via Ollama
 *  2. Convert each contact's name+company+role to a vector (cached in memory)
 *  3. Rank contacts by cosine similarity
 *  4. Return top matches — finds "Maya" even if you say "the creative director"
 *
 * Setup:
 *   ollama pull nomic-embed-text
 *
 * Falls back to regular LIKE search if Ollama is unreachable.
 * Cache is per-process (in-memory). Refreshes when contacts change.
 */
import { ENV } from "./env";
import { searchContacts, getDb } from "../db";
import { contacts as contactsTable } from "../db";
import { eq } from "drizzle-orm";
import type { Contact } from "../../drizzle/schema";

// ── embedding cache ───────────────────────────────────────────────────────────

type CachedContact = {
  contact: Contact;
  embedding: number[];
  text: string;
};

// Per-user cache: userId → list of embedded contacts
const cache = new Map<number, { items: CachedContact[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Ollama embed ──────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const url = `${ENV.ollamaBaseUrl.replace(/\/$/, "")}/api/embeddings`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  if (!resp.ok) throw new Error(`Embed failed: ${resp.status}`);
  const json = await resp.json() as { embedding: number[] };
  return json.embedding;
}

// ── cosine similarity ─────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── contact text for embedding ────────────────────────────────────────────────

function contactToText(c: Contact): string {
  return [c.firstName, c.lastName, c.company, c.role, c.email].filter(Boolean).join(" ");
}

// ── build / refresh cache ─────────────────────────────────────────────────────

async function getEmbeddedContacts(userId: number): Promise<CachedContact[]> {
  const existing = cache.get(userId);
  if (existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) {
    return existing.items;
  }

  const db = await getDb();
  if (!db) return [];

  const allContacts = await db.select().from(contactsTable).where(eq(contactsTable.userId, userId));

  const items: CachedContact[] = [];
  for (const contact of allContacts) {
    try {
      const text = contactToText(contact);
      const embedding = await embed(text);
      items.push({ contact, embedding, text });
    } catch {
      // Skip contacts that fail to embed
    }
  }

  cache.set(userId, { items, fetchedAt: Date.now() });
  return items;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Semantic contact search — finds contacts by meaning, not just exact text.
 * "the creative director at Northstar" → finds Maya Chen
 */
export async function semanticSearchContacts(
  userId: number,
  query: string
): Promise<Contact[]> {
  if (!query.trim()) return [];

  const [queryEmbedding, embeddedContacts] = await Promise.all([
    embed(query),
    getEmbeddedContacts(userId),
  ]);

  if (embeddedContacts.length === 0) return [];

  const scored = embeddedContacts
    .map(({ contact, embedding }) => ({
      contact,
      score: cosine(queryEmbedding, embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .filter(({ score }) => score > 0.3);  // minimum relevance threshold

  return scored.slice(0, 8).map(({ contact }) => contact);
}

/**
 * Invalidate the embedding cache for a user.
 * Call this after creating, updating, or deleting a contact.
 */
export function invalidateContactCache(userId: number) {
  cache.delete(userId);
}
