import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import HubSpotPanel from "./HubSpotPanel";

export default function HubSpotWorkspace() {
  const utils = trpc.useUtils();
  const connection = trpc.hubspot.connection.useQuery(undefined, { retry: false });
  const changedConnection = async () => {
    setRecordId(""); setPages([undefined]); reset();
    await Promise.all([utils.hubspot.invalidate(), utils.integrations.invalidate()]);
  };
  const connect = trpc.hubspot.connect.useMutation({ onSuccess: result => window.location.assign(result.url), onError: e => toast.error(e.message) });
  const disconnect = trpc.hubspot.disconnect.useMutation({ onSuccess: async result => { await changedConnection(); toast.message(result.message); }, onError: e => toast.error(e.message) });
  const useServer = trpc.hubspot.useServerConnection.useMutation({ onSuccess: changedConnection, onError: e => toast.error(e.message) });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search), outcome = params.get("hubspot");
    if (!outcome) return;
    if (outcome === "connected") toast.success("HubSpot connected. Loading your account's records.");
    else toast.error("HubSpot login failed. Check app settings and try again.");
    void utils.hubspot.invalidate(); params.delete("hubspot");
    window.history.replaceState({}, "", `${window.location.pathname}?${params}${window.location.hash}`);
  }, [utils]);
  const [object, setObject] = useState("contacts"), [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [recordId, setRecordId] = useState("");
  const [operation, setOperation] = useState<"create" | "update" | "delete">("update");
  const [values, setValues] = useState<Record<string, string>>({}), [field, setField] = useState("");
  const [propertySearch, setPropertySearch] = useState(""), [deleteText, setDeleteText] = useState("");
  const [association, setAssociation] = useState("contacts"), [associationAfter, setAssociationAfter] = useState<string>();
  const status = trpc.hubspot.status.useQuery(undefined, { retry: false });
  const configured = status.data?.connected === true && !disconnect.isPending;
  const catalog = trpc.hubspot.objects.useQuery(undefined, { enabled: configured, retry: false, staleTime: 300000 });
  const properties = trpc.hubspot.properties.useQuery({ object }, { enabled: configured, retry: false, staleTime: 300000 });
  const records = trpc.hubspot.records.useQuery({ object, query: search, after: pages.at(-1), limit: 50 }, { enabled: configured, retry: false });
  const detail = trpc.hubspot.record.useQuery({ object, id: recordId }, { enabled: !!recordId && configured, retry: false });
  const relations = trpc.hubspot.associations.useQuery({ object, id: recordId, target: association, after: associationAfter }, { enabled: !!recordId && configured, retry: false });
  const draft = trpc.hubspot.draft.useMutation();
  const confirm = trpc.hubspot.confirm.useMutation({ onSuccess: () => { draft.reset(); setValues({}); setDeleteText(""); if (operation === "delete") setRecordId(""); else void detail.refetch(); void records.refetch(); } });
  const reject = trpc.hubspot.reject.useMutation({ onSuccess: () => draft.reset() });
  const busy = draft.isPending || confirm.isPending || reject.isPending;
  const reset = () => { draft.reset(); confirm.reset(); setValues({}); setDeleteText(""); setPropertySearch(""); setAssociationAfter(undefined); };
  const selectRecord = (id: string) => { reset(); setRecordId(id); setOperation("update"); };
  const label = (p: Record<string, string | null>) => p.name || p.dealname || p.subject || p.hs_task_subject || p.hs_title || p.hs_call_title || p.hs_meeting_title || p.hs_email_subject || [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Record";
  const fields = properties.data ?? [];
  return <div className="content-stack">
    <div className="filter-row"><div><p className="eyebrow">Connected CRM</p><h2 className="view-title">HubSpot workspace</h2><p className="text-sm text-muted-foreground">Browse live CRM records, inspect their fields and associations, and review changes before saving.</p></div><Button variant="outline" onClick={() => { void status.refetch(); void records.refetch(); }}>Refresh connection</Button></div>
    <div role="status" className="surface-card rounded-xl border p-4 space-y-3">{status.isLoading ? "Checking HubSpot…" : status.error?.message ?? status.data?.message}
      <p className="text-sm">{connection.data?.mode === "oauth" ? `Your HubSpot login${connection.data.hubId ? ` · Account ${connection.data.hubId}` : ""}` : connection.data?.mode === "server" ? "Using the administrator's shared private-app connection" : "No HubSpot account selected"}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={!connection.data?.oauthConfigured || connect.isPending || disconnect.isPending} onClick={() => connect.mutate()}>{connect.isPending ? "Opening HubSpot…" : configured ? "Switch HubSpot account" : "Sign in to HubSpot"}</Button>
      {connection.data?.mode !== "disconnected" && <Button variant="outline" disabled={disconnect.isPending || connect.isPending} onClick={() => disconnect.mutate()}>Disconnect HubSpot</Button>}
      {!configured && connection.data?.serverTokenAvailable && <Button variant="outline" disabled={useServer.isPending} onClick={() => useServer.mutate()}>Use administrator connection</Button>}</div>
      {!connection.data?.oauthConfigured && <p className="text-sm">Account login needs server settings HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET from a HubSpot OAuth app. Callback: <code className="break-all">{connection.data?.callbackUrl}</code>. A private-app access token only connects its own account.</p>}
      {connection.data?.error && <p role="alert">{connection.data.error}</p>}
      <p className="text-xs text-muted-foreground">Access follows the authorized app scopes and your HubSpot subscription. Disconnect removes this user's local connection; remove the app in HubSpot Connected Apps to revoke its authorization too.</p></div>
    {configured && <>
      {catalog.data?.warning && <details className="text-sm"><summary>Custom object access notice</summary><p>{catalog.data.warning}</p></details>}
      <div className="flex flex-wrap gap-3"><select aria-label="HubSpot object" className="rounded border bg-background p-2 capitalize" value={object} disabled={busy} onChange={e => { reset(); setObject(e.target.value); setRecordId(""); setPages([undefined]); setSearch(""); setQuery(""); }}>
        {(catalog.data?.objects ?? [{ key: "contacts", label: "Contacts" }]).map(o => <option value={o.key} key={o.key}>{o.label}</option>)}
      </select><form className="flex gap-2 flex-1" onSubmit={e => { e.preventDefault(); setSearch(query.trim()); setPages([undefined]); }}><Input aria-label="Search HubSpot" placeholder="Search HubSpot records" value={query} onChange={e => setQuery(e.target.value)} /><Button variant="outline" type="submit">Search</Button></form><Button disabled={busy || !fields.length} onClick={() => { reset(); setRecordId(""); setOperation("create"); }}>Create record</Button></div>
      {records.error && <p role="alert">{records.error.message}</p>}
      {properties.error && <p role="alert">{properties.error.message}</p>}
      <div className="surface-card overflow-auto rounded-xl border"><table className="w-full text-sm"><thead><tr><th className="text-left p-3">Record</th>{records.data?.columns.map(key => <th className="p-3 text-left" key={key}>{fields.find(f => f.name === key)?.label ?? key}</th>)}</tr></thead><tbody>
        {records.data?.records.map(record => <tr className="border-t" key={record.id}><td className="p-3"><button className="text-primary underline" disabled={busy} onClick={() => selectRecord(record.id)}>{label(record.properties)}<span className="block text-xs">#{record.id}</span></button></td>{records.data.columns.map(key => <td className="p-3 max-w-64 truncate" key={key}>{record.properties[key] || "—"}</td>)}</tr>)}
      </tbody></table>{records.isLoading && <p className="p-4">Loading records…</p>}{records.data?.records.length === 0 && <p className="p-4">No matching records.</p>}</div>
      <div className="flex gap-3 items-center"><Button variant="outline" disabled={pages.length < 2 || records.isFetching} onClick={() => setPages(p => p.slice(0, -1))}>Previous</Button><span>Page {pages.length}{records.data?.total !== undefined ? ` · ${records.data.total} search matches` : ""}</span><Button variant="outline" disabled={!records.data?.after || records.isFetching} onClick={() => setPages(p => [...p, records.data!.after!])}>Next page</Button></div>
      {recordId && <section className="surface-card rounded-xl border p-5 space-y-3"><h3 className="font-semibold">{detail.data ? label(detail.data.properties) : "Record details"} · #{recordId}</h3>
        {detail.isLoading && <p>Loading all available properties…</p>}{detail.error && <p role="alert">{detail.error.message}</p>}
        <Input aria-label="Filter record properties" placeholder="Filter fields by label or value" value={propertySearch} onChange={e => setPropertySearch(e.target.value)} />
        <dl className="max-h-96 overflow-auto grid gap-2">{fields.filter(f => detail.data?.properties[f.name] != null && detail.data.properties[f.name] !== "").filter(f => `${f.label} ${f.name} ${detail.data?.properties[f.name]}`.toLowerCase().includes(propertySearch.toLowerCase())).map(f => <div key={f.name} className="grid sm:grid-cols-3 gap-2 border-b py-2"><dt className="font-medium text-sm">{f.label}<small className="block text-muted-foreground">{f.name}</small></dt><dd className="sm:col-span-2 text-sm whitespace-pre-wrap break-all">{detail.data?.properties[f.name]}</dd></div>)}</dl>
        <details><summary>Linked records</summary><select aria-label="Linked HubSpot object" className="rounded border bg-background p-2 my-2" value={association} onChange={e => { setAssociation(e.target.value); setAssociationAfter(undefined); }}>{catalog.data?.objects.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
          {relations.error && <p role="alert">{relations.error.message}</p>}<div className="flex flex-wrap gap-2">{relations.data?.results.map(r => <Button key={String(r.toObjectId)} variant="outline" disabled={busy} onClick={() => { setObject(association); setPages([undefined]); setQuery(""); setSearch(""); selectRecord(String(r.toObjectId)); }}>{association} #{r.toObjectId}</Button>)}</div>
          {relations.data?.results.length === 0 && <p>No linked records of this type.</p>}{relations.data?.paging?.next && <Button variant="outline" onClick={() => setAssociationAfter(String(relations.data!.paging!.next.after))}>Next linked records</Button>}
        </details>
      </section>}
      {(recordId || operation === "create") && <section className="surface-card rounded-xl border p-5 space-y-3"><h3 className="font-semibold">Review a HubSpot change</h3>
        <select aria-label="HubSpot operation" className="rounded border bg-background p-2" value={operation} disabled={busy || !!draft.data} onChange={e => { setOperation(e.target.value as typeof operation); setValues({}); }}><option value="create">Create</option><option value="update" disabled={!recordId}>Edit selected record</option><option value="delete" disabled={!recordId}>Archive selected record</option></select>
        {operation !== "delete" && <><div className="flex gap-2"><select className="rounded border bg-background p-2 min-w-0 flex-1" aria-label="HubSpot field" value={field} disabled={busy || !!draft.data} onChange={e => setField(e.target.value)}><option value="">Choose a field to set</option>{fields.filter(f => !f.calculated && !f.modificationMetadata?.readOnlyValue).map(f => <option value={f.name} key={f.name}>{f.label} ({f.name})</option>)}</select><Button variant="outline" disabled={!field || busy || !!draft.data} onClick={() => { setValues(v => ({ ...v, [field]: operation === "update" ? detail.data?.properties[field] ?? "" : "" })); setField(""); }}>Add field</Button></div>
          {Object.entries(values).map(([key, value]) => { const prop = fields.find(f => f.name === key); return <label key={key} className="block text-sm">{prop?.label ?? key}{prop?.options.length && prop.fieldType !== "checkbox" ? <select className="block w-full border rounded p-2 bg-background" value={value} disabled={busy || !!draft.data} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))}><option value="">Empty</option>{prop.options.map(o => <option value={o.value} key={o.value}>{o.label}</option>)}</select> : <Input value={value} disabled={busy || !!draft.data} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} />}</label>; })}
        </>}
        {!draft.data && <Button disabled={busy || operation !== "delete" && !Object.keys(values).length} onClick={() => draft.mutate({ object, operation, recordId: operation === "create" ? undefined : recordId, values: operation === "delete" ? {} : values })}>Prepare review</Button>}
        {draft.data && <div className="rounded border p-4 space-y-3"><p>{draft.data.operation} {draft.data.object}: {draft.data.label} {draft.data.recordId ? `#${draft.data.recordId}` : ""}</p>{Object.entries(draft.data.values).map(([key, value]) => <p key={key} className="text-sm break-all">{key}: {draft.data?.before?.[key] || "empty"} → {value || "empty"}</p>)}
          {draft.data.operation === "delete" && <Input aria-label="Confirm HubSpot archive" placeholder="Type DELETE to archive this record" value={deleteText} onChange={e => setDeleteText(e.target.value)} />}
          <Button disabled={busy || draft.data.operation === "delete" && deleteText !== "DELETE"} onClick={() => confirm.mutate({ id: draft.data!.id, deleteText })}>Confirm {draft.data.operation === "delete" ? "archive" : "and save"}</Button> <Button variant="outline" disabled={busy} onClick={() => reject.mutate({ id: draft.data!.id })}>Cancel</Button>
        </div>}
        {(draft.error || confirm.error || reject.error) && <p role="alert">{draft.error?.message ?? confirm.error?.message ?? reject.error?.message}</p>}{confirm.data && <p role="status">{confirm.data.message}</p>}
      </section>}
      {connection.data?.mode === "server" && <HubSpotPanel />}
    </>}
  </div>;
}
