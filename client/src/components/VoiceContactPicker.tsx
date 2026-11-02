import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Input } from "@/components/ui/input";
import type { ContactChoice } from "@shared/voice";

export function VoiceContactPicker({ value, label, candidates, disabled, onChange }: { value: number | null; label: string; candidates: ContactChoice[]; disabled: boolean; onChange: (choice: ContactChoice | null) => void }) {
  const [query, setQuery] = useState(label);
  const searchQuery = useDebouncedValue(query.trim());
  const results = trpc.contacts.search.useQuery({ query: searchQuery, limit: 20 }, { enabled: searchQuery.length > 0, retry: false });
  const choices = new Map(candidates.map(choice => [choice.id, choice]));
  for (const contact of results.data ?? []) choices.set(contact.id, { id: contact.id, name: `${contact.firstName} ${contact.lastName}`, company: contact.company, email: contact.email });
  return <div className="space-y-2"><Input aria-label="Search for the action contact" value={query} disabled={disabled} onChange={event => { setQuery(event.target.value); onChange(null); }} placeholder="Search contacts" /><select aria-label="Choose the action contact" className="w-full rounded border bg-background p-2 text-sm" value={value ?? ""} disabled={disabled} onChange={event => onChange(choices.get(Number(event.target.value)) ?? null)}><option value="">Choose a contact</option>{[...choices.values()].map(choice => <option key={choice.id} value={choice.id}>{choice.name}{choice.company ? ` · ${choice.company}` : ""}{choice.email ? ` · ${choice.email}` : ""} · #{choice.id}</option>)}</select>{!value && <p className="text-xs text-amber-700">Choose a specific contact before saving.</p>}</div>;
}
