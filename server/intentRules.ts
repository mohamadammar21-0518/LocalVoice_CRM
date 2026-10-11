/** Conservative shortcuts for common commands; complex requests go to the local model. */
export function commonCrmIntent(prompt: string, contextName?: string) {
  const text = prompt.trim().replace(/[?.!]$/, "");
  const base = { contactQuery: null as string | null, taskFilter: "all" as "all" | "open" | "overdue", limit: 5, actions: [] as { type: string; contactName: string; note: string | null; taskTitle: string | null; dueDate: null; dateExpression: string | null; reason: null }[] };
  const person = (value: string) => /^(him|her|them|dia)$/i.test(value.trim()) ? contextName ?? value.trim() : value.trim();
  if (/^(delete|remove|hapus|padam)\b/i.test(text) || /^(send|hantar)\b.*\b(email|e-mail|e-mel)\b/i.test(text) || /\b(weather|cuaca)\b/i.test(text)) return { ...base, kind: "unsupported" };
  if (/^(how many|berapa banyak|berapa jumlah)\b/i.test(text) && /\b(contacts?|tasks?|follow-ups?|kenalan|tugasan|susulan)\b/i.test(text)) return { ...base, kind: "dashboard" };
  if (/^(dashboard|overview|summary|ringkasan|gambaran keseluruhan|status crm)$/i.test(text)) return { ...base, kind: "dashboard" };
  if (/^(?:open|pending|overdue|late|terbuka|tertunggak|lewat) (?:tasks?|follow-ups?|reminders?|tugasan|susulan)(?: (?:for|untuk) (.+))?$/i.test(text)) {
    const name = /(?:for|untuk)\s+(.+)$/i.exec(text);
    return { ...base, kind: "tasks", contactQuery: name ? person(name[1]) : null, taskFilter: /\b(overdue|late|lewat|tertunggak)\b/i.test(text) ? "overdue" : "open" };
  }
  if (/^(show|list|what are|tunjukkan|senaraikan)\b/i.test(text) && /\b(tasks?|follow-ups?|reminders?|tugasan|susulan)\b/i.test(text) && !/\b(and|then|dan|kemudian)\b/i.test(text)) {
    const name = /\b(?:for|untuk)\s+(.+)$/i.exec(text);
    return { ...base, kind: "tasks", contactQuery: name ? person(name[1]) : null, taskFilter: /\b(overdue|late|lewat|tertunggak)\b/i.test(text) ? "overdue" : /\b(open|pending|terbuka|belum selesai)\b/i.test(text) ? "open" : "all" };
  }
  let match = /^(?:what did I (?:last )?discuss with|what was my last conversation with|show (?:the )?(?:history|notes|interactions) (?:for|with)|tunjukkan (?:nota|sejarah|interaksi) (?:untuk|dengan))\s+(.+)$/i.exec(text);
  if (match) return { ...base, kind: "history", contactQuery: person(match[1]), limit: /\blast\b/i.test(text) ? 1 : 5 };
  match = /^(?:look up|find|search for|cari)\s+([^,;]+)$/i.exec(text);
  if (match && !/\b(and|then|dan|kemudian)\b/i.test(match[1])) return { ...base, kind: "contacts", contactQuery: person(match[1]) };
  if (/^(show|list|tunjukkan|senaraikan) (?:all |my |semua )?(?:contacts|kenalan)$/i.test(text)) return { ...base, kind: "contacts" };
  match = /^(?:who is|contact details for|details for|siapa|butiran kenalan)\s+(.+)$/i.exec(text);
  if (match) return { ...base, kind: "contacts", contactQuery: person(match[1]), limit: 1 };
  match = /^(?:add|save) (?:a )?note (?:to|for) (.+?) (?:that|saying) (.+)$/i.exec(text) ?? /^(?:tambah|simpan) nota untuk (.+?) (?:bahawa|yang menyatakan) (.+)$/i.exec(text);
  if (match && !/\b(?:and remind|and create|dan buat|dan ingatkan)\b/i.test(text)) {
    const name = person(match[1]);
    return { ...base, kind: "propose", contactQuery: name, actions: [{ type: "add_note", contactName: name, note: match[2], taskTitle: null, dueDate: null, dateExpression: null, reason: null }] };
  }
  match = /^(?:create|add|buat|tambah) (?:a )?(?:follow-up|reminder|susulan) (?:for|untuk) (.+?) (today|tomorrow|hari ini|esok|lusa|next (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|(?:Isnin|Selasa|Rabu|Khamis|Jumaat|Sabtu|Ahad) depan|in \d{1,3} days?|dalam \d{1,3} hari|\d{4}-\d{2}-\d{2}) (?:to|untuk) (.+)$/i.exec(text);
  if (match) {
    const name = person(match[1]);
    return { ...base, kind: "propose", contactQuery: name, actions: [{ type: "create_follow_up", contactName: name, note: null, taskTitle: match[3], dueDate: null, dateExpression: match[2], reason: null }] };
  }
  return null;
}
