/** Deliberately exact phrases: a sentence containing "yes" is never approval. */
export function callControl(text: string): "confirm" | "confirmDelete" | "cancel" | "repeat" | "end" | null {
  const clean = text.toLowerCase().replace(/[.!?,]/g, "").replace(/\s+/g, " ").trim();
  if (["confirm change", "yes confirm", "yes confirm change", "sahkan perubahan", "ya sahkan"].includes(clean)) return "confirm";
  if (["confirm delete", "confirm deletion", "sahkan padam"].includes(clean)) return "confirmDelete";
  if (["cancel change", "no cancel", "cancel that", "batalkan perubahan"].includes(clean)) return "cancel";
  if (["repeat", "repeat that", "read it again", "ulang"].includes(clean)) return "repeat";
  if (["end call", "hang up", "goodbye", "tamat panggilan"].includes(clean)) return "end";
  return null;
}

export type CallReply = {
  text: string;
  reviewId?: string;
  end?: boolean;
  saved?: boolean;
};
