import "dotenv/config";
import { studioStore, audit } from "../server/crm/store";
import { studioService } from "../server/crm/service";
import { remoteProvider } from "../server/crm/providers";
import { crmTemplates } from "../shared/crm";
import { getUserByOpenId, closeDb } from "../server/db";
import { checkReadiness } from "../server/_core/health";
import type { TrpcContext } from "../server/_core/context";
import { studioRouter } from "../server/crm/router";

if (!process.argv.includes("--run")) throw new Error("Pass --run to create/reuse the local MVP workspace and fictional demo record");
try {
  const user = await getUserByOpenId(`local_${process.env.LOCAL_ADMIN_USERNAME ?? "admin"}`);
  if (!user || user.role !== "admin") throw new Error("Configured administrator is unavailable");
  const ctx = { user } as TrpcContext;
  const name = "LocalVoice MVP Demo";
  const existing = (await studioStore.list(user.id)).find(w => w.name === name && w.role === "owner");
  const blueprint = structuredClone(crmTemplates[0].blueprint);
  blueprint.name = name;
  const id = existing?.id ?? await studioStore.create(user.id, blueprint);
  console.log(`MVP_WORKSPACE_ID=${id}`);
  let { workspace } = await studioStore.read(user.id, id);
  if (workspace.provider === "local" && !workspace.records.some(r => r.object === "companies" && r.values.name === "Nova Labs (Demo)")) {
    const proposal = await studioService.draft(ctx, id, { operation: "create", object: "companies", values: { name: "Nova Labs (Demo)" } });
    await studioService.confirm(ctx, id, proposal.id);
    console.log("Created fictional local company through the reviewed-action workflow.");
  }
  const readiness = await checkReadiness(true);
  console.log(`Local services: ${JSON.stringify(readiness.services)}`);
  if (readiness.services.llm) {
    const caller = studioRouter.createCaller(ctx);
    for (const prompt of ["Create a company named Voice Demo Example", "Cipta syarikat bernama Contoh Demo"]) {
      try {
        const result = await caller.plan({ workspaceId: id, object: "companies", prompt });
        if (!result.proposal || result.proposal.action.operation !== "create") throw new Error("Command did not produce a create proposal");
        await caller.reject({ workspaceId: id, proposalId: result.proposal.id });
        console.log(`Command planning passed: ${prompt}. Test proposal rejected after validation.`);
      } catch { console.log(`Command planning needs investigation: ${prompt}`); process.exitCode = 1; }
    }
  }
  if (!process.env.HUBSPOT_ACCESS_TOKEN) { console.log("HubSpot token missing"); }
  else {
    process.env.HUBSPOT_STUDIO_WORKSPACE_ID = id;
    workspace = (await studioStore.read(user.id, id)).workspace;
    const remote = remoteProvider({ ...workspace, provider: "hubspot", mappings: { companies: { remoteObject: "companies", fields: { name: "name" } } } }, ctx);
    try {
      const schema = await remote.schema("companies");
      if (!schema.objects[0]?.fields.some(f => f.key === "name" && f.writable)) throw new Error("Company name is not writable");
      const records = await remote.list("companies", "");
      await studioStore.mutate(user.id, id, ["owner"], w => {
        w.mappings.companies ??= { remoteObject: "companies", fields: { name: "name" } };
        audit(w, user.id, "mvp.hubspot.readVerified", "Company schema and first record page read; local provider retained");
      });
      console.log(`HubSpot verified: company schema readable; ${records.records.length} records on first page. No remote records changed.`);
    } catch (error) {
      // Provider errors are sanitized by remoteRequest; never print raw HTTP payloads.
      console.log(`HubSpot check failed: ${error instanceof Error ? error.message : "request failed"}`);
      process.exitCode = 1;
    }
  }
} finally { await closeDb(); }
