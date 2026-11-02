import "dotenv/config";
import { invokeLLM } from "../server/_core/llm";
import { studioPlannerPrompt, bindStudioSelection } from "../shared/training";
import { crmTemplates, actionSchema } from "../shared/crm";

// Synthetic prompts only. No database access and no CRM writes.
const object = crmTemplates[0].blueprint.objects.find(o => o.key === "companies")!;
const id = "11111111-1111-4111-8111-111111111111";
for (const [prompt, expectedOperation] of [["Create a company named Nova Labs", "create"], ["Update the selected company industry to Quality assurance", "update"], ["Cipta syarikat bernama Contoh Demo", "create"]]) {
  const result = await invokeLLM({ messages: [{ role: "system", content: studioPlannerPrompt(object, id) }, { role: "user", content: prompt }], responseFormat: { type: "json_object" }, maxTokens: 3000 });
  const raw = bindStudioSelection(JSON.parse(result.choices[0].message.content), id) as Record<string, any>;
  const expectedValues = expectedOperation === "update" ? { industry: "Quality assurance" } : { name: prompt.startsWith("Cipta") ? "Contoh Demo" : "Nova Labs" };
  const valid = actionSchema.safeParse(raw).success && raw.operation === expectedOperation && raw.object === object.key && (raw.operation === "create" || raw.recordId === id) && JSON.stringify(raw.values) === JSON.stringify(expectedValues);
  console.log(JSON.stringify({ prompt, timing: result.timing, usage: result.usage, valid, result: raw }));
  if (!valid) process.exitCode = 1;
}
