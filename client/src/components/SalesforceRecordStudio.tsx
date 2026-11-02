import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";

type Operation = "read" | "create" | "update" | "delete";
type Entry = { field: string; value: string };
const blank: Entry = { field: "", value: "" };
export const voiceOperation = (text: string): Operation => /\b(delete|remove|padam|hapus)\b/i.test(text) ? "delete" : /\b(update|edit|change|set|kemas kini|ubah)\b/i.test(text) ? "update" : /\b(create|add|new|buat|cipta|tambah)\b/i.test(text) ? "create" : "read";

export default function SalesforceRecordStudio({ transcript = "", onSaved }: { transcript?: string; onSaved?: (message: string) => void }) {
  const utils = trpc.useUtils();
  const objects = trpc.salesforce.objects.useQuery(undefined, { retry: false, staleTime: 5 * 60000 });
  const [object, setObject] = useState("Contact");
  const [operation, setOperation] = useState<Operation>("read");
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [recordId, setRecordId] = useState("");
  const [recordLabel, setRecordLabel] = useState("");
  const [entries, setEntries] = useState<Entry[]>([{ ...blank }]);
  const [review, setReview] = useState<inferRouterOutputs<AppRouter>["salesforce"]["prepareChange"] | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [lastTranscript, setLastTranscript] = useState("");
  const detail = trpc.salesforce.describeObject.useQuery({ object }, { enabled: !!object, retry: false, staleTime: 5 * 60000 });
  const records = trpc.salesforce.listRecords.useQuery({ object, search: submitted }, { enabled: !!object && operation !== "create" && !!detail.data?.queryable, retry: false });
  const selectedRecord = trpc.salesforce.getRecord.useQuery({ object, id: recordId }, { enabled: !!object && !!recordId && operation !== "create", retry: false });
  const reject = trpc.salesforce.rejectChange.useMutation();
  const prepare = trpc.salesforce.prepareChange.useMutation({ onSuccess: setReview, onError: error => toast.error(error.message) });
  const confirm = trpc.salesforce.confirmChange.useMutation({ onSuccess: result => {
    toast.success(result.deleted ? "Salesforce record deleted" : "Salesforce record saved");
    onSaved?.(result.deleted ? "Salesforce record deleted." : "Salesforce record saved.");
    setReview(null); setDeleteText(""); setEntries([{ ...blank }]);
    if (result.deleted) { setRecordId(""); setRecordLabel(""); }
    else if (result.id) { setRecordId(result.id); setOperation("read"); }
    void Promise.all([utils.salesforce.listRecords.invalidate(), utils.salesforce.getRecord.invalidate(), utils.salesforce.findContact.invalidate(), utils.salesforce.openTasks.invalidate()]);
  }, onError: error => toast.error(error.message) });
  const writableFields = useMemo(() => detail.data?.fields.filter(field => operation === "create" ? field.createable : field.updateable) ?? [], [detail.data, operation]);

  useEffect(() => {
    if (!transcript.trim() || transcript === lastTranscript || !objects.data) return;
    setLastTranscript(transcript);
    const lower = transcript.toLowerCase();
    const match = [...objects.data].filter(item => lower.includes(item.name.toLowerCase()) || lower.includes(item.label.toLowerCase())).sort((a, b) => b.label.length - a.label.length)[0];
    const action = voiceOperation(transcript);
    if (match) {
      setObject(match.name); setRecordId(""); setRecordLabel("");
      const target = transcript.split(/[,;\n]/, 1)[0]
        .replace(/^(?:please\s+)?(?:find|look up|search for|read|show|create|add|new|update|edit|change|set|delete|remove|cari|baca|buat|cipta|tambah|ubah|padam|hapus)\s+/i, "")
        .replace(new RegExp(`^\\s*(?:${match.name}|${match.label})\\s*`, "i"), "")
        .replace(/^(?:named|called|with name|bernama)\s+/i, "").trim();
      if (action !== "create" && target) { setSearch(target); setSubmitted(target); }
      else setSubmitted("");
    }
    setOperation(action); setReview(null);
  }, [transcript, lastTranscript, objects.data]);

  useEffect(() => {
    if (operation === "create" || recordId || !submitted || records.data?.records.length !== 1) return;
    const only = records.data.records[0];
    setRecordId(only.Id); setRecordLabel(only.label);
  }, [operation, recordId, submitted, records.data]);

  useEffect(() => {
    if (!transcript.trim() || !detail.data || lastTranscript !== transcript) return;
    const parsed: Entry[] = [];
    for (const segment of transcript.split(/[,;\n]+/)) {
      const match = detail.data.fields.filter(field => (operation === "create" ? field.createable : field.updateable) && new RegExp(`^\\s*(?:${field.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${field.name})\\s*(?:=|:|is|to|jadi)\\s*(.+)$`, "i").test(segment)).sort((a, b) => b.label.length - a.label.length)[0];
      if (!match) continue;
      const value = segment.match(/(?:=|:|\bis\b|\bto\b|\bjadi\b)\s*(.+)$/i)?.[1]?.trim();
      if (value) parsed.push({ field: match.name, value });
    }
    if (parsed.length) setEntries(parsed);
  }, [transcript, detail.data, lastTranscript, operation]);

  function chooseObject(name: string) { setObject(name); setRecordId(""); setRecordLabel(""); setSubmitted(""); setReview(null); setEntries([{ ...blank }]); }
  function submitChange() {
    if (!object) return;
    const fields: Record<string, string> = {};
    for (const entry of entries) if (entry.field) fields[entry.field] = entry.value;
    if (operation !== "delete" && !Object.keys(fields).length) { toast.error("Add at least one field and value"); return; }
    prepare.mutate({ object, operation: operation as "create" | "update" | "delete", ...(recordId ? { id: recordId } : {}), ...(operation === "delete" ? {} : { fields }) });
  }
  const current = objects.data?.find(item => item.name === object);
  return <Card className="surface-card"><CardHeader><CardTitle>Salesforce records</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">Browse objects your Salesforce user can access. Speak a request in the Voice tab or use the controls here. Review every write before saving. Example: “Create Account, Name = Acme Demo, Phone = 5551234.” For editing or deleting, select the exact record before review.</p>
    {objects.isFetching && <p>Loading Salesforce objects…</p>}{objects.error && <p role="alert">{objects.error.message}</p>}
    <nav aria-label="Salesforce record sections" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {([['Account', 'Accounts'], ['Contact', 'Contacts'], ['Opportunity', 'Opportunities · Deals'], ['Task', 'Tasks'], ['Lead', 'Leads'], ['Case', 'Cases'], ['Event', 'Events'], ['Campaign', 'Campaigns']] as const).map(([name, label]) => <Button key={name} variant={object === name ? "default" : "outline"} disabled={!objects.data?.some(o => o.name === name)} onClick={() => { chooseObject(name); setOperation("read"); }}>{label}</Button>)}
    </nav>
    <p className="text-xs text-muted-foreground">These sections use your organization's actual Salesforce objects, fields, and permissions. Salesforce calls deals Opportunities. Additional and custom objects are in the selector below.</p>
    {transcript && <p className="rounded bg-muted p-2 text-sm">Voice request: {transcript}</p>}
    <div className="flex flex-wrap gap-3"><label>Object <select className="ml-2 rounded border p-2 bg-background" value={object} onChange={event => chooseObject(event.target.value)}><option value="">Choose an object</option>{objects.data?.map(item => <option key={item.name} value={item.name}>{item.label} ({item.name})</option>)}</select></label><label>Action <select className="ml-2 rounded border p-2 bg-background" value={operation} onChange={event => { setOperation(event.target.value as Operation); setReview(null); setEntries([{ ...blank }]); }}><option value="read">Read</option>{current?.createable && <option value="create">Create</option>}{current?.updateable && <option value="update">Edit</option>}{current?.deletable && <option value="delete">Delete</option>}</select></label></div>
    {detail.error && <p role="alert">{detail.error.message}</p>}
    {object && operation !== "create" && <div className="space-y-2"><form className="flex gap-2" onSubmit={event => { event.preventDefault(); setSubmitted(search.trim()); void records.refetch(); }}><Input aria-label="Search Salesforce records" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by name, or leave blank for first 50" /><Button variant="outline">Browse</Button></form>{records.isFetching && <p>Reading records…</p>}{records.error && <p role="alert">{records.error.message}</p>}{records.data?.truncated && <p className="text-sm">Showing the first 50 records. Narrow the search.</p>}<div className="max-h-48 overflow-auto space-y-1">{records.data?.records.map(row => <button key={row.Id} className={`block w-full rounded border p-2 text-left text-sm ${recordId === row.Id ? "bg-muted" : ""}`} onClick={() => { setRecordId(row.Id); setRecordLabel(row.label); setReview(null); }}>{row.label} <span className="text-muted-foreground">{row.Id}</span></button>)}</div>{selectedRecord.error && <p role="alert">{selectedRecord.error.message}</p>}{selectedRecord.data && <details className="text-sm"><summary className="cursor-pointer">Read selected record: {recordLabel}</summary><dl className="max-h-64 overflow-auto grid grid-cols-2 gap-2 p-2">{detail.data?.fields.filter(field => selectedRecord.data?.record[field.name] != null).map(field => <div key={field.name}><dt className="font-medium">{field.label}</dt><dd className="break-all">{String(selectedRecord.data?.record[field.name])}</dd></div>)}</dl></details>}</div>}
    {(operation === "create" || operation === "update") && object && <div className="space-y-2"><p className="font-medium">Fields to {operation}</p>{entries.map((entry, index) => <div key={index} className="flex flex-wrap gap-2"><select aria-label={`Field ${index + 1}`} className="rounded border p-2 bg-background" value={entry.field} onChange={event => setEntries(value => value.map((item, at) => at === index ? { ...item, field: event.target.value } : item))}><option value="">Choose field</option>{writableFields.map(field => <option key={field.name} value={field.name}>{field.label}</option>)}</select>{writableFields.find(field => field.name === entry.field)?.type === "picklist" ? <select aria-label={`Value ${index + 1}`} className="rounded border p-2 bg-background" value={entry.value} onChange={event => setEntries(value => value.map((item, at) => at === index ? { ...item, value: event.target.value } : item))}><option value="">Choose value</option>{writableFields.find(field => field.name === entry.field)?.picklistValues?.filter(option => option.active).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <Input aria-label={`Value ${index + 1}`} className="max-w-xs" value={entry.value} onChange={event => setEntries(value => value.map((item, at) => at === index ? { ...item, value: event.target.value } : item))} placeholder="Value" />}<Button variant="ghost" onClick={() => setEntries(value => value.filter((_, at) => at !== index))}>Remove</Button></div>)}<Button variant="outline" onClick={() => setEntries(value => [...value, { ...blank }])}>Add field</Button></div>}
    {operation !== "read" && object && <Button disabled={prepare.isPending || (operation !== "create" && !recordId) || (operation === "create" && !current?.createable)} onClick={submitChange}>Review {operation}</Button>}
    {review && <div className="rounded border p-4 space-y-3" role="region" aria-label="Salesforce change review"><h3 className="font-semibold">Confirm {review.operation} {review.label}</h3>{review.id && <p>Record: {recordLabel || review.id} ({review.id})</p>}{Object.entries(review.fields).map(([field, value]) => <p key={field}><strong>{field}:</strong> {String(value)}</p>)}{review.operation === "delete" && <label className="block">Type DELETE to confirm removal <Input aria-label="Type DELETE" value={deleteText} onChange={event => setDeleteText(event.target.value)} /></label>}<div className="flex gap-2"><Button variant={review.operation === "delete" ? "destructive" : "default"} disabled={confirm.isPending || (review.operation === "delete" && deleteText !== "DELETE")} onClick={() => confirm.mutate({ token: review.token, deleteText: review.operation === "delete" ? deleteText : undefined })}>{confirm.isPending ? "Saving…" : `Confirm ${review.operation}`}</Button><Button variant="outline" onClick={() => { reject.mutate({ token: review.token }); setReview(null); setDeleteText(""); }}>Cancel</Button></div></div>}
  </CardContent></Card>;
}
