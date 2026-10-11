import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ImportKind } from "../../../server/hubspotImport";

export default function HubSpotPanel() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ImportKind>("contacts");
  const [after, setAfter] = useState<string | undefined>();
  const [allowUpdates, setAllowUpdates] = useState(false);
  const [remoteIds, setRemoteIds] = useState<Record<number, string>>({});
  const utils = trpc.useUtils();
  const jobs = trpc.integrations.syncJobs.useQuery(undefined, { enabled: open });
  const importer = trpc.integrations.importPage.useMutation({
    onSuccess: page => {
      if (page.applied) {
        toast.success(`Imported ${page.items.filter(item => item.operation !== "skip").length} HubSpot records`);
        void Promise.all([utils.contacts.list.invalidate(), utils.contacts.get.invalidate(), utils.interactions.list.invalidate(), utils.tasks.list.invalidate(), utils.dashboard.get.invalidate()]);
      }
    },
    onError: error => toast.error(error.message),
  });
  const reconcile = trpc.integrations.reconcileSync.useMutation({ onSuccess: () => { toast.success("Sync reconciled"); void jobs.refetch(); }, onError: error => toast.error(error.message) });
  const page = importer.data;
  const updates = page?.items.some(item => item.operation === "update") ?? false;
  return <Card className="surface-card mt-6"><CardHeader><div className="flex justify-between items-center gap-3"><CardTitle>HubSpot records</CardTitle><Button variant="outline" onClick={() => setOpen(!open)}>{open ? "Close" : "Import and sync status"}</Button></div></CardHeader>{open && <CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">Import contacts first, then their notes and tasks. Each page contains up to 100 records. A matching email links a local contact without replacing its details.</p>
    <div className="flex flex-wrap gap-3"><select aria-label="HubSpot records to import" className="rounded border p-2 bg-background" value={kind} disabled={importer.isPending} onChange={event => { setKind(event.target.value as ImportKind); setAfter(undefined); importer.reset(); setAllowUpdates(false); }}><option value="contacts">Contacts</option><option value="notes">Notes</option><option value="tasks">Tasks</option></select><Button disabled={importer.isPending} onClick={() => { setAllowUpdates(false); importer.mutate({ kind, after, apply: false }); }}>{importer.isPending ? "Reading…" : "Preview this page"}</Button><Button variant="ghost" disabled={importer.isPending} onClick={() => { setAfter(undefined); importer.reset(); }}>First page</Button></div>
    {page && <><p className="text-sm">{page.items.length} records · {page.items.filter(item => item.operation === "insert").length} new · {page.items.filter(item => item.operation === "update").length} updates · {page.items.filter(item => item.operation === "link").length} links · {page.items.filter(item => item.operation === "skip").length} skipped</p><div className="max-h-72 overflow-auto border rounded"><table className="w-full text-sm"><thead><tr><th className="text-left p-2">Record</th><th className="text-left p-2">Change</th></tr></thead><tbody>{page.items.map(item => <tr key={item.remoteId} className="border-t"><td className="p-2">{item.label} <small>#{item.remoteId}</small></td><td className="p-2">{item.operation}{item.reason ? ` · ${item.reason}` : ""}</td></tr>)}</tbody></table></div>
      {!page.applied && <>{updates && <label className="text-sm flex gap-2"><input type="checkbox" checked={allowUpdates} onChange={event => setAllowUpdates(event.target.checked)} />Replace the displayed fields of records already linked to HubSpot with the current HubSpot values.</label>}<Button className="primary-button" disabled={importer.isPending || updates && !allowUpdates || !page.items.some(item => item.operation !== "skip")} onClick={() => importer.mutate({ kind, after, apply: true, fingerprint: page.fingerprint })}>Confirm this page and import</Button></>}
      {page.after && <Button variant="outline" disabled={importer.isPending} onClick={() => { setAfter(page.after!); importer.reset(); setAllowUpdates(false); }}>Next page</Button>}
    </>}
    <details><summary className="cursor-pointer text-sm">Recent outbound sync jobs</summary><p className="text-sm my-3">For an uncertain result, verify the remote record in HubSpot and enter its ID. Reconciliation links that verified ID and allows future updates.</p>{jobs.data?.map(job => <div className="border-t py-3 text-sm" key={job.id}><p>{job.kind} #{job.localId} · {job.status}{job.remoteId ? ` · HubSpot #${job.remoteId}` : ""}</p>{job.error && <p>{job.error}</p>}{["uncertain", "running"].includes(job.status) && <div className="flex gap-2 mt-2"><Input aria-label={`Verified HubSpot ID for ${job.kind} ${job.localId}`} value={remoteIds[job.id] ?? ""} onChange={event => setRemoteIds(value => ({ ...value, [job.id]: event.target.value }))} placeholder="Verified remote record ID" /><Button disabled={reconcile.isPending || !/^\d+$/.test(remoteIds[job.id] ?? "")} onClick={() => reconcile.mutate({ kind: job.kind, localId: job.localId, remoteId: remoteIds[job.id] })}>Confirm link</Button></div>}</div>)}{jobs.error && <p>Sync jobs could not be loaded.</p>}</details>
  </CardContent>}</Card>;
}
