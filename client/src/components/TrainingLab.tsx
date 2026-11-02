import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { Blueprint } from "@shared/crm";
import { commandTrainingSchema, speechTrainingSchema } from "@shared/training";

export default function TrainingLab({
  workspaceId,
  blueprint,
  writable,
}: {
  workspaceId: string;
  blueprint: Blueprint;
  writable: boolean;
}) {
  const [task, setTask] = useState<"command" | "speech">("command");
  const [prompt, setPrompt] = useState("");
  const [expected, setExpected] = useState(
    '{"clarification":"Select the exact record first"}'
  );
  const [objectKey, setObjectKey] = useState(blueprint.objects[0].key);
  const [selectedId, setSelectedId] = useState("");
  const [group, setGroup] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [language, setLanguage] = useState<"en" | "ms">("en");
  const [consent, setConsent] = useState(false);
  const rows = trpc.studio.training.list.useQuery({ workspaceId });
  const recentSessions = trpc.voice.history.useQuery({ limit: 20, offset: 0 }, { enabled: task === "speech" });
  const utils = trpc.useUtils();
  const add = trpc.studio.training.add.useMutation({
    onError: e => toast.error(e.message),
    onSuccess: () => {
      void rows.refetch();
      setConsent(false);
      toast.success("Reviewed example saved locally");
    },
  });
  const remove = trpc.studio.training.remove.useMutation({
    onError: e => toast.error(e.message),
    onSuccess: () => void rows.refetch(),
  });
  function save() {
    try {
      const sample =
        task === "command"
          ? commandTrainingSchema.parse({
              task,
              prompt,
              object: blueprint.objects.find(o => o.key === objectKey),
              selectedRecordId: selectedId || undefined,
              today: new Date().toISOString().slice(0, 10),
              expected: JSON.parse(expected),
            })
          : speechTrainingSchema.parse({
              task,
              sessionId: Number(sessionId),
              transcript: prompt,
              language,
              speakerGroup: speaker,
              entities: [],
            });
      add.mutate({ workspaceId, sample, group, reviewed: true, consent: true });
    } catch {
      toast.error(
        "Check the corrected action JSON, schema and required fields"
      );
    }
  }
  return (
    <div className="studio-stack">
      <div className="studio-card studio-stack">
        <h3>Training Lab</h3>
        <p>
          Build two reviewed datasets: commands with correct actions, and
          recordings with corrected transcripts. Samples stay local; nothing
          trains or uploads automatically.
        </p>
        <p className="training-stats">
          <span>
            {rows.data?.filter(r => r.sample.task === "command").length ?? 0}{" "}
            commands
          </span>
          <span>
            {rows.data?.filter(r => r.sample.task === "speech").length ?? 0}{" "}
            speech clips
          </span>
        </p>
        <p>
          Use fictional CRM data when possible. A scenario group keeps
          paraphrases together; speaker groups prevent the same speaker leaking
          into the speech test set.
        </p>
        <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
          <strong>Personal dictation calibration</strong>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>In Voice, choose <em>Accurate (Whisper)</em> and record a short, natural request.</li>
            <li>Choose that recording below, replace the transcript with exactly what you said, then save it.</li>
            <li>Repeat across quiet/noisy settings, CRM names, dates, English and Malay. Do not train until every label is reviewed.</li>
          </ol>
        </div>
        {rows.error && <p role="alert">{rows.error.message}</p>}
        {writable && (
          <>
            <div className="training-toolbar">
              <select
                aria-label="Training task"
                value={task}
                onChange={e => {
                  setTask(e.target.value as typeof task);
                  setConsent(false);
                }}
              >
                <option value="command">CRM command</option>
                <option value="speech">Speech recognition</option>
              </select>
              <Input
                aria-label="Scenario group"
                placeholder="Scenario group, e.g. sales-follow-up-001"
                value={group}
                onChange={e => setGroup(e.target.value)}
              />
            </div>
            {task === "command" ? (
              <>
                <select
                  aria-label="Training object"
                  value={objectKey}
                  onChange={e => setObjectKey(e.target.value)}
                >
                  {blueprint.objects.map(o => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label="Training selected record"
                  placeholder="Selected record ID, only for update/delete examples"
                  value={selectedId}
                  onChange={e => setSelectedId(e.target.value)}
                />
                <label>
                  Command
                  <Textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                  />
                </label>
                <label>
                  Correct action JSON or clarification
                  <Textarea
                    className="studio-code"
                    rows={6}
                    value={expected}
                    onChange={e => setExpected(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Recent recording
                  <select
                    aria-label="Recent voice recording"
                    value={sessionId}
                    onChange={e => {
                      const value = e.target.value;
                      setSessionId(value);
                      const session = recentSessions.data?.find(item => String(item.id) === value);
                      if (session) setPrompt(session.transcript ?? "");
                    }}
                  >
                    <option value="">Choose one of your last 20 recordings</option>
                    {recentSessions.data?.map(session => <option key={session.id} value={session.id}>#{session.id} — {(session.transcript ?? "").slice(0, 85) || "No transcript"}</option>)}
                  </select>
                </label>
                {recentSessions.isLoading && <p className="text-sm text-muted-foreground">Loading your recordings…</p>}
                {!recentSessions.isLoading && !recentSessions.data?.length && <p className="text-sm text-muted-foreground">No recordings yet. Make a short recording in Voice first.</p>}
                <Input
                  aria-label="Speaker group"
                  placeholder="Speaker ID, e.g. my-voice"
                  value={speaker}
                  onChange={e => setSpeaker(e.target.value)}
                />
                <select
                  aria-label="Speech language"
                  value={language}
                  onChange={e => setLanguage(e.target.value as typeof language)}
                >
                  <option value="en">English</option>
                  <option value="ms">Malay</option>
                </select>
                <label>
                  Exact corrected transcript
                  <Textarea
                    rows={5}
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                  />
                </label>
                <small>
                  Use clips up to 30 seconds. Keep the words as spoken, including
                  mixed-language speech. Use a different scenario group for each
                  distinct request; use the same speaker ID for your own voice.
                </small>
              </>
            )}
            <label className="studio-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={e => setConsent(e.target.checked)}
              />
              I reviewed this correction and have permission to use this
              text/audio for model training.
            </label>
            <Button
              disabled={
                !consent || !prompt.trim() || group.length < 2 || add.isPending
              }
              onClick={save}
            >
              Save reviewed example
            </Button>
          </>
        )}
        <Button
          variant="outline"
          onClick={async () => {
            try {
              const result = await utils.studio.training.export.fetch({
                workspaceId,
              });
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(result, null, 2)], {
                  type: "application/json",
                })
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "training-review.json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
        >
          Export review manifest
        </Button>
        <p>
          For trainable JSONL and audio export, use the local training guide.
          This browser manifest does not include audio files.
        </p>
      </div>
      <div className="studio-card studio-stack">
        <h3>Reviewed examples</h3>
        {rows.data?.map(r => (
          <div className="studio-audit training-audit-item" key={r.id}>
            <strong>
              {r.sample.task} · {r.group}
            </strong>
            <p>
              {r.sample.task === "command"
                ? r.sample.prompt
                : r.sample.transcript}
            </p>
            {writable && (
              <Button
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ workspaceId, sampleId: r.id })}
              >
                Remove from future exports
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
