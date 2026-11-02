import { readFile, writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { crmTemplates } from "../shared/crm";

// Explicit local setup: credentials never leave the server configuration.
const source = dotenv.parse(await readFile(".env"));
const stagingText = await readFile(".env.staging", "utf8");
const staging = dotenv.parse(stagingText);
const origin = staging.APP_ORIGIN;
if (origin !== "https://localhost:3100") throw new Error("Only local staging is supported");
for (const key of ["TWENTY_API_KEY", "HUBSPOT_ACCESS_TOKEN"])
  if (!source[key] || /^(REPLACE_|CHANGE_|YOUR_|PLACEHOLDER|<)/i.test(source[key])) throw new Error(`${key} is missing`);
const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ username: staging.LOCAL_ADMIN_USERNAME, password: staging.LOCAL_ADMIN_PASSWORD }) });
if (!login.ok) throw new Error(`Local login failed: ${login.status}`);
const cookie = login.headers.get("set-cookie")!.split(";")[0];
const headers = { "Content-Type": "application/json", Origin: origin, Cookie: cookie };
const response = await fetch(`${origin}/api/trpc/studio.list`, { headers });
if (!response.ok) throw new Error("Could not list workspaces");
const list = (await response.json()).result.data.json as { id: string; name: string; role: string }[];
const existing = list.filter(w => w.name === "My CRM" && w.role === "owner");
if (existing.length > 1) throw new Error("Multiple My CRM workspaces: choose an exact workspace before setup");
let id = existing[0]?.id;
if (!id) {
  const blueprint = structuredClone(crmTemplates.find(t => t.id === "sales")!.blueprint);
  blueprint.name = "My CRM";
  const created = await fetch(`${origin}/api/trpc/studio.create`, { method: "POST", headers, body: JSON.stringify({ json: blueprint }) });
  if (!created.ok) throw new Error(`Workspace creation failed: ${created.status}`);
  id = (await created.json()).result.data.json;
}
if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unexpected workspace ID");
const updates: Record<string, string> = {
  TWENTY_WORKSPACE_ID: id, TWENTY_API_URL: "http://host.docker.internal:3001", TWENTY_API_KEY: source.TWENTY_API_KEY,
  HUBSPOT_STUDIO_WORKSPACE_ID: id, HUBSPOT_ACCESS_TOKEN: source.HUBSPOT_ACCESS_TOKEN,
};
const lines = stagingText.split(/\r?\n/).filter(line => !Object.keys(updates).some(key => line.startsWith(`${key}=`)));
await writeFile(".env.staging", lines.join("\n").trimEnd() + "\n" + Object.entries(updates).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
console.log(JSON.stringify({ workspace: "My CRM", id, credentialsAssigned: ["twenty", "hubspot"], restartRequired: true }));
