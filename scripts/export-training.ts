import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { studioStore } from "../server/crm/store";
import { closeDb } from "../server/db";
import { studioPlannerPrompt, trainingInput } from "../shared/training";
import { storageLocalPath } from "../server/storage";

async function main() {
  const [user, workspaceId, destination] = process.argv.slice(2);
  if (!/^[1-9]\d*$/.test(user ?? "") || !workspaceId || !destination)
    throw new Error(
      "Usage: export-training.ts USER_ID WORKSPACE_ID OUTPUT_DIRECTORY"
    );
  const { workspace } = await studioStore.read(Number(user), workspaceId);
  const root = path.resolve(destination);
  await fs.mkdir(root, { recursive: true });
  if ((await fs.readdir(root)).length)
    throw new Error(
      "Output directory must be empty; existing datasets are never overwritten"
    );
  await fs.mkdir(path.join(root, "audio"));
  const commands: unknown[] = [],
    speech: unknown[] = [];
  for (const e of workspace.training ?? []) {
    if (e.userId !== Number(user) || !e.consent || !e.reviewed) continue;
    const { sample } = trainingInput.parse(e);
    if (sample.task === "command")
      commands.push({
        id: e.id,
        group: e.group,
        reviewed: true,
        consent: true,
        selectedRecordId: sample.selectedRecordId,
        messages: [
          {
            role: "system",
            content: studioPlannerPrompt(
              sample.object,
              sample.selectedRecordId,
              sample.today
            ),
          },
          { role: "user", content: sample.prompt },
          { role: "assistant", content: JSON.stringify({ ...sample.expected, recordId: undefined }) },
        ],
      });
    else if (e.recordingKey) {
      const source = storageLocalPath(e.recordingKey);
      const filename = `${e.id}${path.extname(source)}`;
      const bytes = await fs.readFile(source);
      await fs.writeFile(path.join(root, "audio", filename), bytes, {
        flag: "wx",
      });
      speech.push({
        id: e.id,
        audio: `audio/${filename}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        text: sample.transcript,
        language: sample.language,
        speaker: sample.speakerGroup,
        group: e.group,
        entities: sample.entities,
        reviewed: true,
        consent: true,
      });
    }
  }
  for (const [name, rows] of [
    ["commands.jsonl", commands],
    ["speech.jsonl", speech],
  ] as const)
    await fs.writeFile(
      path.join(root, name),
      rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
      { flag: "wx" }
    );
  console.log(
    JSON.stringify({
      commands: commands.length,
      speech: speech.length,
      output: root,
      note: "Private dataset. Review personal information before moving it to another machine.",
    })
  );
}
void main()
  .catch(e => {
    console.error(
      e instanceof Error && !("sql" in e) ? e.message : "Training export failed"
    );
    process.exitCode = 1;
  })
  .finally(closeDb);
