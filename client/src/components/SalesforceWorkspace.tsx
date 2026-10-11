import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export default function SalesforceWorkspace() {
  const [request, setRequest] = useState("Find Maya Chen");
  const [submitted, setSubmitted] = useState("");
  const [contactId, setContactId] = useState("");
  const status = trpc.salesforce.status.useQuery(undefined, { retry: false, refetchOnWindowFocus: true });
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
    toast.message(result === "connected" ? "Salesforce connected. Search for your fictional contact." : "Salesforce connection failed. Check app settings and reconnect.");
    params.delete("salesforce"); window.history.replaceState({}, "", window.location.pathname + (params.size ? `?${params}` : "") + window.location.hash);
  }, []);
  return <div className="content-stack"><Card className="surface-card"><CardHeader><CardTitle>Salesforce contact and task lookup</CardTitle></CardHeader><CardContent className="space-y-4">
    <p>Find a contact in your Salesforce organisation, choose the correct person, and view their open tasks. This milestone reads records only.</p>
    {status.error && <p role="alert">{status.error.message}</p>}
    {status.isLoading && <p role="status">Checking your Salesforce connection…</p>}
    {status.data?.connectionError && <div role="alert"><p>{status.data.connectionError}</p><Button variant="outline" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Clear saved connection</Button></div>}
    {status.data && !status.data.configured && <div className="rounded border p-4 space-y-2"><p>Create a <a className="underline" href="https://developer.salesforce.com/signup" target="_blank" rel="noreferrer">Salesforce Developer Edition organisation</a>, then configure an External Client App and the server settings described in SALESFORCE_SETUP.md.</p><p>Callback URL: <code>{status.data.callbackUrl}</code></p><p>Restart the CRM after changing its configuration.</p></div>}
    {status.data?.configured && !status.data.connected && <Button disabled={connect.isPending} onClick={() => connect.mutate()}>Connect my Salesforce account</Button>}
    {status.data?.connected && <><div className="flex flex-wrap gap-3 items-center"><p>Connected to {status.data.organisation}</p><Button variant="outline" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button></div><p className="text-sm text-muted-foreground">{status.data.persistent ? "Your connection is saved with encryption and survives server restarts." : "Reconnect after server restarts; encrypted connection storage has not been configured."} Your Salesforce permissions determine which records are visible.</p>
      <form className="flex gap-3" onSubmit={event => { event.preventDefault(); setContactId(""); const value = request.trim(); if (value === submitted) void contacts.refetch(); else setSubmitted(value); }}><Input aria-label="Typed Salesforce contact request" maxLength={200} value={request} onChange={event => setRequest(event.target.value)} placeholder="Find Maya Chen" /><Button disabled={!request.trim() || contacts.isFetching}>Find contact</Button></form>
      {contacts.isFetching && <p>Reading Salesforce contacts…</p>}{contacts.error && <p role="alert">{contacts.error.message}</p>}
      {contacts.data && <div className="space-y-3"><p>{contacts.data.contacts.length ? "Choose the contact whose tasks you want to view:" : "No contacts matched. Check the name and your Salesforce record access."}</p>{contacts.data.truncated && <p>Showing the first 20 matches. Enter a more specific name.</p>}{contacts.data.contacts.map(contact => <button key={contact.Id} className={`block w-full text-left rounded border p-3 ${contactId === contact.Id ? "bg-muted" : ""}`} onClick={() => { if (contactId === contact.Id) void tasks.refetch(); else setContactId(contact.Id); }}><strong>{contact.Name}</strong><span className="block text-sm">{contact.Account?.Name ?? "No company"} · {contact.Email ?? "No email"}</span></button>)}</div>}
    </>}
  </CardContent></Card>
  {status.data?.connected && contactId && <Card className="surface-card"><CardHeader><CardTitle>Open tasks{tasks.data ? ` for ${tasks.data.contact.Name}` : ""}</CardTitle></CardHeader><CardContent>{tasks.isFetching && <p>Reading open tasks…</p>}{tasks.error && <p role="alert">{tasks.error.message}</p>}{tasks.data && <><p className="mb-3">{tasks.data.tasks.length} open task{tasks.data.tasks.length === 1 ? "" : "s"}{tasks.data.truncated ? " (first 100 shown)" : ""}.</p>{tasks.data.tasks.map(task => <div key={task.Id} className="border-t py-3"><strong>{task.Subject}</strong><p>{task.Status} · {task.Priority} · {task.ActivityDate ? `Due ${task.ActivityDate}` : "No due date"}</p></div>)}{!tasks.data.tasks.length && <p>No open tasks are directly linked to this contact. In Salesforce, set a task’s Name field to this contact; a task related only to the company or opportunity won’t appear here.</p>}<Button className="mt-3" variant="outline" onClick={() => void tasks.refetch()}>Refresh tasks</Button></>}</CardContent></Card>}
  </div>;
}
