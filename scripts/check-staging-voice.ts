import { promises as fs } from "node:fs";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { crmTemplates } from "../shared/crm";

if (!process.argv.includes("--run")) throw new Error("Pass --run to create labelled synthetic voice fixtures in staging");
const config = dotenv.parse(await fs.readFile(".env.staging"));
const origin = "https://localhost:3100";
assert.equal(config.APP_ORIGIN, origin);
const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ username: config.LOCAL_ADMIN_USERNAME, password: config.LOCAL_ADMIN_PASSWORD }), signal: AbortSignal.timeout(15000) });
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")!.split(";")[0];
async function mutation(name: string, input: unknown): Promise<any> {
  const response = await fetch(`${origin}/api/trpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify({ json: input }), signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`${name} failed with HTTP ${response.status}`);
  return (await response.json()).result.data.json;
}
const started = performance.now();
const tts = await fetch(`${origin}/api/voice/tts`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify({ text: "Create a company named Staging Demo." }), signal: AbortSignal.timeout(30000) });
assert.equal(tts.status, 200);
const audio = Buffer.from(await tts.arrayBuffer());
assert.ok(audio.length > 44);
const ttsMs = Math.round(performance.now() - started);
const recognitionStart = performance.now();
const recognition = await mutation("voice.transcribe", { audioBase64: audio.toString("base64"), mimeType: "audio/wav", filename: "staging-synthetic.wav", language: "en" });
assert.match(recognition.transcript, /create a company named/i);
const expectedTranscript = "Create a company named Staging Demo.";
const transcriptMatched = recognition.transcript.trim().toLowerCase() === expectedTranscript.toLowerCase();
const sttMs = Math.round(performance.now() - recognitionStart);
const blueprint = structuredClone(crmTemplates[0].blueprint);
blueprint.name = `Synthetic voice acceptance ${new Date().toISOString()}`;
const workspaceId = await mutation("studio.create", blueprint);
const planningStart = performance.now();
// Emulate the explicit transcript review available in the UI. Never silently
// count a corrected transcript as an accurate recognition result.
const plan = await mutation("studio.plan", { workspaceId, object: "companies", prompt: expectedTranscript });
assert.equal(plan.proposal?.action.operation, "create");
assert.deepEqual(plan.proposal.action.values, { name: "Staging Demo" });
const planMs = Math.round(performance.now() - planningStart);
// Only confirm this exact fictional company, never arbitrary generated values.
const result = await mutation("studio.confirm", { workspaceId, proposalId: plan.proposal.id });
assert.ok(result.id);
const query = encodeURIComponent(JSON.stringify({ json: { workspaceId, object: "companies", search: "Staging Demo" } }));
const read = await fetch(`${origin}/api/trpc/studio.records?input=${query}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) });
assert.equal(read.status, 200);
const records = (await read.json()).result.data.json.records;
assert.ok(records.some((r: any) => r.id === result.id && r.values.name === "Staging Demo"));
console.log(JSON.stringify({ reviewedWorkflowPassed: true, transcriptMatched, reviewedCorrectionApplied: !transcriptMatched, ttsMs, sttMs, planMs, workspaceId, note: "Synthetic English audio with explicit transcript review, exact-value proposal, local staging write and read-back. No microphone, Malay accuracy, or external CRM write was tested." }));
