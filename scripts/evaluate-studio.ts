import "dotenv/config";
import { promises as fs } from "node:fs";
import { actionSchema } from "../shared/crm";
import { bindStudioSelection } from "../shared/training";
import { invokeLLM, type Message } from "../server/_core/llm";

async function main() {
  const [dataset, output, model] = process.argv.slice(2);
  if (!dataset || !output)
    throw new Error(
      "Usage: evaluate-studio.ts TEST_JSONL OUTPUT_JSON [OLLAMA_MODEL]"
    );
  const rows = (await fs.readFile(dataset, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  if (!rows.length) throw new Error("Evaluation set is empty");
  const canonical = (x: unknown): string =>
    JSON.stringify(x, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          )
        : value
    );
  const results = [];
  for (const [i, row] of rows.entries()) {
    const messages: Message[] = row.prompt ?? row.messages.slice(0, -1);
    const expectedRaw = JSON.parse(
      (row.completion ?? row.messages.slice(-1))[0].content
    );
    const selectedRecordId = row.selectedRecordId ?? expectedRaw.recordId;
    const expected = bindStudioSelection(expectedRaw, selectedRecordId) as typeof expectedRaw;
    const start = performance.now();
    try {
      const response = await invokeLLM({
        messages,
        model,
        responseFormat: { type: "json_object" },
        maxTokens: 500,
      });
      const actual = bindStudioSelection(JSON.parse(response.choices[0].message.content), selectedRecordId) as typeof expectedRaw;
      const safe =
        typeof actual.clarification === "string" ||
        actionSchema.safeParse(actual).success;
      const passed = Boolean(
        expected.clarification
          ? typeof actual.clarification === "string" &&
              actual.clarification.length > 0 &&
              !actual.operation
          : safe &&
              canonical(actionSchema.parse(actual)) ===
                canonical(actionSchema.parse(expected))
      );
      results.push({
        id: row.id ?? i,
        passed,
        valid: safe,
        unsafeWrite: Boolean(expected.clarification && actual.operation),
        durationMs: Math.round(performance.now() - start),
      });
    } catch {
      results.push({
        id: row.id ?? i,
        passed: false,
        valid: false,
        unsafeWrite: false,
        durationMs: Math.round(performance.now() - start),
      });
    }
  }
  const report = {
    model: model ?? process.env.OLLAMA_MODEL,
    examples: rows.length,
    passed: results.filter(r => r.passed).length,
    valid: results.filter(r => r.valid).length,
    unsafeWrites: results.filter(r => r.unsafeWrite).length,
    meanLatencyMs: Math.round(
      results.reduce((n, r) => n + r.durationMs, 0) / rows.length
    ),
    results,
  };
  await fs.writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ...report, results: undefined }));
  if (report.passed !== report.examples) process.exitCode = 1;
}
void main().catch(e => {
  console.error(e instanceof Error ? e.message : "Evaluation failed");
  process.exitCode = 1;
});
