import "dotenv/config";
import { promises as fs } from "node:fs";
import { planVoiceRequest } from "../server/voiceAssistant";
import { percentile } from "../server/metrics";
import { closeDb } from "../server/db";

type Case = { prompt: string; kind: string; contactQuery?: string; taskFilter?: string; limit?: number; actions?: string[]; dateExpression?: string };
async function run() {
  // Planner evaluation makes local inference requests only; no CRM or HubSpot writes.
  const cases = JSON.parse(await fs.readFile("evaluation/voice-cases.json", "utf8")) as Case[];
  const results = [];
  for (const sample of cases) {
    const start = performance.now();
    try {
      const { intent, response } = await planVoiceRequest({ prompt: sample.prompt, timezone: "Asia/Kuala_Lumpur", source: "local" }, null, { now: new Date("2026-10-07T02:00:00Z") });
      const success = intent.kind === sample.kind && (!sample.contactQuery || intent.contactQuery === sample.contactQuery) && (!sample.taskFilter || intent.taskFilter === sample.taskFilter) && (!sample.limit || intent.limit === sample.limit) && (!sample.actions || JSON.stringify(intent.actions.map(action => action.type)) === JSON.stringify(sample.actions)) && (!sample.dateExpression || intent.actions.some(action => action.dateExpression?.toLowerCase() === sample.dateExpression?.toLowerCase()));
      results.push({ prompt: sample.prompt, success, intent, durationMs: response.timing.totalMs, loadMs: response.timing.loadMs, tokens: response.usage });
      console.log(`${results.length}/${cases.length}: ${success ? "passed" : "failed"} (${Math.round(response.timing.totalMs)}ms)`);
    } catch { results.push({ prompt: sample.prompt, success: false, error: "Inference or schema validation failed", durationMs: Math.round(performance.now() - start) }); }
  }
  const times = results.map(result => result.durationMs);
  const report = { model: process.env.OLLAMA_MODEL, cases: results.length, passed: results.filter(result => result.success).length, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), results };
  await fs.writeFile("evaluation/latest-report.json", JSON.stringify(report, null, 2));
  console.log(`${report.passed}/${report.cases} cases passed. p50=${report.p50Ms}ms, p95=${report.p95Ms}ms. Report: evaluation/latest-report.json`);
  if (report.passed !== report.cases) process.exitCode = 1;
}
void run().catch(() => { console.error("Evaluation could not complete"); process.exitCode = 1; }).finally(closeDb);
