import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { studioRouter } from "./router";
import { newWorkspace, studioStore, type Workspace } from "./store";
import { crmTemplates } from "../../shared/crm";
import type { TrpcContext } from "../_core/context";

let workspace: Workspace;
const caller = studioRouter.createCaller({ user: { id: 1, sessionVersion: 0 } } as TrpcContext);
beforeEach(() => {
  workspace = newWorkspace(crmTemplates[0].blueprint);
  vi.spyOn(studioStore, "read").mockImplementation(async () => ({ workspace, role: "owner" }));
  vi.spyOn(studioStore, "mutate").mockImplementation(async (_user, _id, _roles, fn) => fn(workspace));
  vi.stubEnv("HUBSPOT_STUDIO_WORKSPACE_ID", workspace.id);
  vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "test-token");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("preserves each provider's mappings when switching", async () => {
  const mappings = { companies: { remoteObject: "companies", fields: { name: "name" } } };
  await caller.configure({ workspaceId: workspace.id, revision: workspace.revision, provider: "hubspot", mappings });
  await caller.configure({ workspaceId: workspace.id, revision: workspace.revision, provider: "local", mappings: {} });
  expect(workspace.provider).toBe("local");
  expect(workspace.providerMappings?.hubspot).toEqual(mappings);
  expect(workspace.mappings).toEqual({});
});

it("inspects a candidate provider without activating it", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [{ name: "name", label: "Name", type: "string", modificationMetadata: { readOnlyValue: false } }] }));
  vi.stubGlobal("fetch", fetchMock);
  const schema = await caller.remoteSchema({ workspaceId: workspace.id, provider: "hubspot", object: "companies" });
  expect(schema.objects[0].fields.some(f => f.key === "name")).toBe(true);
  expect(String(fetchMock.mock.calls[0][0])).toContain("api.hubapi.com");
  expect(workspace.provider).toBe("local");
});

it("rejects selecting an unconfigured provider", async () => {
  vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "REPLACE_WITH_TOKEN");
  await expect(caller.configure({ workspaceId: workspace.id, revision: workspace.revision, provider: "hubspot", mappings: {} })).rejects.toThrow("Configure this provider");
  expect(workspace.provider).toBe("local");
});
