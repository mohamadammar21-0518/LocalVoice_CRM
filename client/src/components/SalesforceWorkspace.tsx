import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import SalesforceRecordStudio from "./SalesforceRecordStudio";

export default function SalesforceWorkspace() {
  const [request, setRequest] = useState("Find Maya Chen");
  const [submitted, setSubmitted] = useState("");
  const [contactId, setContactId] = useState("");
  const status = trpc.salesforce.status.useQuery(undefined, { retry: false, refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const connect = trpc.salesforce.connect.useMutation({ onSuccess: result => window.location.assign(result.url), onError: error => toast.error(error.message) });
  const disconnect = trpc.salesforce.disconnect.useMutation({ onSuccess: result => {
    setSubmitted(""); setContactId(""); utils.salesforce.findContact.reset(); utils.salesforce.openTasks.reset(); void status.refetch();
    toast.message(result.revoked ? "Salesforce disconnected" : "Disconnected locally. Remove the app’s authorization in Salesforce to revoke remote access.");
  }, onError: error => toast.error(error.message) });
  const contacts = trpc.salesforce.findContact.useQuery({ request: submitted }, { enabled: Boolean(status.data?.connected && submitted), retry: false, staleTime: 0 });
  const tasks = trpc.salesforce.openTasks.useQuery({ contactId }, { enabled: Boolean(status.data?.connected && contactId), retry: false, staleTime: 0 });
  useEffect(() => { if (contacts.error || tasks.error) void utils.salesforce.status.invalidate(); }, [contacts.error, tasks.error, utils]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("salesforce");
    if (!result) return;
    if (result === "connected") {
      toast.success("Salesforce connected and synchronized.");
      void Promise.all([
        utils.salesforce.status.invalidate(),
        utils.salesforce.objects.invalidate(),
        utils.salesforce.findContact.invalidate(),
        utils.salesforce.openTasks.invalidate(),
      ]);
    } else toast.error("Salesforce connection failed. Check app settings and reconnect.");
    params.delete("salesforce"); window.history.replaceState({}, "", window.location.pathname + (params.size ? `?${params}` : "") + window.location.hash);
  }, [utils]);
  return <div className="content-stack"><Card className="surface-card"><CardHeader className="salesforce-header"><CardTitle>Salesforce contact and task lookup</CardTitle></CardHeader><CardContent className="space-y-4">
    <p>Find a contact and view open tasks below. The record workspace also lets you read and change accessible Salesforce objects after review.</p>
    {status.error && <p role="alert">{status.error.message}</p>}
    {status.isLoading && <p role="status">Checking your Salesforce connection…</p>}
    {status.data?.connectionError && <div role="alert"><p>{status.data.connectionError}</p>{status.data.configured && <Button variant="outline" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Clear saved connection</Button>}</div>}
    {status.data && !status.data.configured && <div className="rounded border p-4 space-y-2"><p>Salesforce is not configured for this Docker environment. Configure the External Client App settings described in SALESFORCE_SETUP.md, then restart this CRM.</p><p>Callback URL: <code className="break-all">{status.data.callbackUrl}</code></p></div>}
    {status.data?.configured && !status.data.connected && <Button disabled={connect.isPending} onClick={() => connect.mutate()}>{connect.isPending ? "Opening Salesforce login…" : "Sign in to Salesforce"}</Button>}
    {status.data?.connected && <><div className="flex flex-wrap gap-3 items-center"><span className="salesforce-brand-pill salesforce-connected"><span style={{width:'6px',height:'6px',borderRadius:'50%',background:'currentColor',display:'inline-block'}} />{status.data.organisation}</span><Button variant="outline" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button></div><p className="text-sm text-muted-foreground">{status.data.persistent ? "Your connection is saved with encryption and survives server restarts." : "Reconnect after server restarts; encrypted connection storage has not been configured."} Your Salesforce permissions determine which records are visible.</p>
      <form className="salesforce-search-form flex gap-3" onSubmit={event => { event.preventDefault(); setContactId(""); const value = request.trim(); if (value === submitted) void contacts.refetch(); else setSubmitted(value); }}><Input aria-label="Typed Salesforce contact request" maxLength={200} value={request} onChange={event => setRequest(event.target.value)} placeholder="Find Maya Chen" /><Button disabled={!request.trim() || contacts.isFetching}>Find contact</Button></form>
      {contacts.isFetching && <p>Reading Salesforce contacts…</p>}{contacts.error && <p role="alert">{contacts.error.message}</p>}
      {contacts.data && <div className="space-y-3"><p>{contacts.data.contacts.length ? "Choose the contact whose tasks you want to view:" : "No contacts matched. Check the name and your Salesforce record access."}</p>{contacts.data.truncated && <p>Showing the first 20 matches. Enter a more specific name.</p>}{contacts.data.contacts.map(contact => <button key={contact.Id} className={`sf-contact-btn${contactId === contact.Id ? " selected" : ""}`} onClick={() => { if (contactId === contact.Id) void tasks.refetch(); else setContactId(contact.Id); }}><strong>{contact.Name}</strong><span className="block text-sm">{contact.Account?.Name ?? "No company"} · {contact.Email ?? "No email"}</span></button>)}</div>}
    </>}
  </CardContent></Card>
  {status.data?.connected && contactId && <Card className="surface-card"><CardHeader><CardTitle>Open tasks{tasks.data ? ` for ${tasks.data.contact.Name}` : ""}</CardTitle></CardHeader><CardContent>{tasks.isFetching && <p>Reading open tasks…</p>}{tasks.error && <p role="alert">{tasks.error.message}</p>}{tasks.data && <><p className="mb-3">{tasks.data.tasks.length} open task{tasks.data.tasks.length === 1 ? "" : "s"}{tasks.data.truncated ? " (first 100 shown)" : ""}.</p>{tasks.data.tasks.map(task => <div key={task.Id} className="border-t py-3"><strong>{task.Subject}</strong><p>{task.Status} · {task.Priority} · {task.ActivityDate ? `Due ${task.ActivityDate}` : "No due date"}</p></div>)}{!tasks.data.tasks.length && <p>No open tasks are directly linked to this contact. In Salesforce, set a task’s Name field to this contact; a task related only to the company or opportunity won’t appear here.</p>}<Button className="mt-3" variant="outline" onClick={() => void tasks.refetch()}>Refresh tasks</Button></>}</CardContent></Card>}
    {status.data?.connected && <SalesforceRecordStudio />}
  </div>;
}
