import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Mic,
  Square,
  Plus,
  ArrowLeft,
  Download,
  RefreshCw,
  Sparkles,
  Database,
  ShieldCheck,
  Plug,
} from "lucide-react";
import {
  blueprintSchema,
  crmTemplates,
  type Blueprint,
  type CrmRecord,
  type Values,
  type ProviderId,
} from "@shared/crm";
import "./crm-studio.css";
import TrainingLab from "./TrainingLab";
import StudioGettingStarted from "./StudioGettingStarted";
import TwentyGallery from "./TwentyGallery";

const error = (e: { message: string }) => toast.error(e.message);
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([pretty(value)], { type: "application/json" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BlueprintEditor({
  value,
  onChange,
}: {
  value: Blueprint;
  onChange: (b: Blueprint) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(pretty(value));
  return (
    <div className="studio-stack">
      <label>
        Workspace name
        <Input
          value={value.name}
          onChange={e => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <label>
        Description
        <Textarea
          value={value.description}
          onChange={e => onChange({ ...value, description: e.target.value })}
        />
      </label>
      {value.objects.map((o, oi) => (
        <div className="studio-card" key={oi}>
          <div className="studio-row">
            <Input
              aria-label="Object label"
              value={o.label}
              onChange={e =>
                onChange({
                  ...value,
                  objects: value.objects.map((item, i) =>
                    i === oi ? { ...item, label: e.target.value } : item
                  ),
                })
              }
            />
            <code>{o.key}</code>
            <Button
              variant="ghost"
              onClick={() =>
                onChange({
                  ...value,
                  objects: value.objects.filter((_, i) => i !== oi),
                })
              }
            >
              Remove object
            </Button>
          </div>
          {o.fields.map((f, fi) => (
            <div className="studio-field-row" key={fi}>
              <Input
                aria-label="Field label"
                value={f.label}
                onChange={e =>
                  onChange({
                    ...value,
                    objects: value.objects.map((item, i) =>
                      i === oi
                        ? {
                            ...item,
                            fields: item.fields.map((field, j) =>
                              j === fi
                                ? { ...field, label: e.target.value }
                                : field
                            ),
                          }
                        : item
                    ),
                  })
                }
              />
              <code>{f.key}</code>
              <span>
                {f.type}
                {f.required ? " · required" : ""}
                {f.target ? ` → ${f.target}` : ""}
              </span>
              <Button
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...value,
                    objects: value.objects.map((item, i) =>
                      i === oi
                        ? {
                            ...item,
                            fields: item.fields.filter((_, j) => j !== fi),
                          }
                        : item
                    ),
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <AddField
            blueprint={value}
            onAdd={field =>
              onChange({
                ...value,
                objects: value.objects.map((item, i) =>
                  i === oi ? { ...item, fields: [...item.fields, field] } : item
                ),
              })
            }
          />
        </div>
      ))}
      <Button
        variant="outline"
        onClick={() => {
          const key = `custom${value.objects.length + 1}`;
          onChange({
            ...value,
            objects: [
              ...value.objects,
              {
                key,
                label: "Custom object",
                plural: "Custom objects",
                aliases: [],
                fields: [
                  {
                    key: "name",
                    label: "Name",
                    type: "text",
                    required: true,
                    options: [],
                    aliases: [],
                  },
                ],
              },
            ],
          });
        }}
      >
        <Plus size={16} /> Add object
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setJson(pretty(value));
          setAdvanced(!advanced);
        }}
      >
        Advanced JSON / import blueprint
      </Button>
      {advanced && (
        <>
          <Textarea
            className="studio-code"
            aria-label="Blueprint JSON"
            rows={16}
            value={json}
            onChange={e => setJson(e.target.value)}
          />
          <Button
            variant="outline"
            onClick={() => {
              try {
                onChange(blueprintSchema.parse(JSON.parse(json)));
                toast.success("Blueprint validated");
              } catch (e) {
                error(e as Error);
              }
            }}
          >
            Validate and load JSON
          </Button>
        </>
      )}
    </div>
  );
}
function AddField({
  blueprint,
  onAdd,
}: {
  blueprint: Blueprint;
  onAdd: (f: Blueprint["objects"][number]["fields"][number]) => void;
}) {
  const [key, setKey] = useState("");
  const [type, setType] =
    useState<Blueprint["objects"][number]["fields"][number]["type"]>("text");
  const [choices, setChoices] = useState("");
  const [target, setTarget] = useState(blueprint.objects[0]?.key ?? "");
  const [required, setRequired] = useState(false);
  return (
    <div className="studio-row">
      <Input
        aria-label="New field key"
        placeholder="New field key e.g. customerTier"
        value={key}
        onChange={e => setKey(e.target.value)}
      />
      <select
        aria-label="Field type"
        value={type}
        onChange={e => setType(e.target.value as typeof type)}
      >
        {[
          "text",
          "number",
          "boolean",
          "date",
          "email",
          "select",
          "relation",
        ].map(t => (
          <option key={t}>{t}</option>
        ))}
      </select>
      {type === "select" && (
        <Input
          aria-label="Choices"
          placeholder="Choices, comma separated"
          value={choices}
          onChange={e => setChoices(e.target.value)}
        />
      )}
      {type === "relation" && (
        <select
          aria-label="Relation target"
          value={target}
          onChange={e => setTarget(e.target.value)}
        >
          {blueprint.objects.map(o => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <label className="studio-check">
        <input
          type="checkbox"
          checked={required}
          onChange={e => setRequired(e.target.checked)}
        />
        Required
      </label>
      <Button
        variant="outline"
        disabled={!key}
        onClick={() => {
          onAdd({
            key,
            label: key.replace(/([A-Z])/g, " $1"),
            type,
            required,
            options: choices
              .split(",")
              .map(s => s.trim())
              .filter(Boolean),
            aliases: [],
            ...(type === "relation" ? { target } : {}),
          });
          setKey("");
        }}
      >
        Add field
      </Button>
    </div>
  );
}

export default function CrmStudio() {
  const [id, setId] = useState<string>();
  const [draft, setDraft] = useState<Blueprint>();
  const [description, setDescription] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const list = trpc.studio.list.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const create = trpc.studio.create.useMutation({
    onError: error,
    onSuccess: id => {
      void utils.studio.list.invalidate();
      setDraft(undefined);
      setId(id);
    },
  });
  const generate = trpc.studio.generate.useMutation({
    onError: error,
    onSuccess: setDraft,
  });
  if (id)
    return (
      <StudioWorkspace
        key={id}
        id={id}
        back={() => {
          setId(undefined);
        }}
      />
    );
  return (
    <section className="studio studio-stack">
      <div className="studio-banner">
        <div>
          <p className="eyebrow">CRM Studio</p>
          <h2>A workspace shaped around your business.</h2>
          <p>Start with a template, customize your data, then work by voice.</p>
        </div>
        <Database size={38} />
      </div>
      <details className="studio-card studio-guide">
        <summary>Setup guide & service health</summary>
        <StudioGettingStarted />
      </details>
      {list.error && (
        <p role="alert">
          {list.error.message} · Check database access and apply any pending migrations.
        </p>
      )}
      {list.isLoading && <p>Loading workspaces…</p>}
      {!!list.data?.length && (
        <div className="studio-grid">
          {list.data.map(w => (
            <button
              className="studio-card studio-workspace"
              key={w.id}
              onClick={() => {
                setId(w.id);
              }}
            >
              <Database size={22} />
              <strong>{w.name}</strong>
              <span>{w.role} workspace →</span>
            </button>
          ))}
        </div>
      )}
      {!draft ? (
        <>
          <div className="studio-library-heading">
            <div><p className="eyebrow">Template library</p><h3>Choose a CRM. Make it yours.</h3><p>Preview the included objects, customize the fields, then create your workspace.</p></div>
            <Input aria-label="Search CRM templates" placeholder="Search templates…" value={templateSearch} onChange={e => setTemplateSearch(e.target.value)} />
          </div>
          <div className="studio-grid">
            {crmTemplates.filter(t => `${t.blueprint.name} ${t.blueprint.description} ${t.blueprint.objects.map(o => o.plural).join(" ")}`.toLowerCase().includes(templateSearch.toLowerCase().trim())).map(t => (
              <button
                key={t.id}
                className={`studio-card studio-workspace studio-template studio-template-${t.id}`}
                onClick={() => setDraft(structuredClone(t.blueprint))}
              >
                <span className="studio-template-icon"><Sparkles size={22} /></span>
                <strong>{t.blueprint.name}</strong>
                <span>{t.blueprint.description}</span>
                <span className="studio-object-chips">{t.blueprint.objects.map(o => <span key={o.key}>{o.plural}</span>)}</span>
                <small>
                  {t.blueprint.objects.reduce((n, o) => n + o.fields.length, 0)} fields included · Customize template →
                </small>
              </button>
            ))}
          </div>
          {!crmTemplates.some(t => `${t.blueprint.name} ${t.blueprint.description} ${t.blueprint.objects.map(o => o.plural).join(" ")}`.toLowerCase().includes(templateSearch.toLowerCase().trim())) && <div className="studio-card" role="status"><h3>No matching templates</h3><p>Try sales, property or recruitment, or describe your business below.</p><Button variant="outline" onClick={() => setTemplateSearch("")}>Show all templates</Button></div>}
          <TwentyGallery onUseRealEstate={() => { setDraft(structuredClone(crmTemplates.find(t => t.id === "twenty-real-estate")!.blueprint)); window.scrollTo({ top: 0, behavior: "instant" }); }} />
          <div className="studio-card studio-twenty-guide">
            <div><p className="eyebrow">Connect to Twenty</p><h3>Your template, inside your CRM.</h3><p>The library includes LocalVoice starters and a labeled adaptation of Twenty’s real-estate schema. To create their objects in Twenty, first create a workspace here, then open <strong>Connections → Preview Twenty provisioning</strong>. Review the changes before confirming.</p><p>A configured Twenty API key is required. Existing local records are not copied automatically. The official application catalog links to full upstream apps that require separate installation.</p></div>
            <a href="https://github.com/twentyhq/twenty" target="_blank" rel="noreferrer" className="studio-resource-link">Explore Twenty ↗</a>
          </div>
          <div className="studio-card studio-stack">
            <h3>Describe your CRM</h3>
            <Textarea
              aria-label="Business description"
              placeholder="We run a recruitment agency and need candidates, jobs and interviews…"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
            <Button
              disabled={generate.isPending || description.length < 5}
              onClick={() => generate.mutate({ description })}
            >
              {generate.isPending
                ? "Drafting your CRM…"
                : "Generate draft with local AI"}
            </Button>
            <small>
              Uses your existing Ollama model. Templates work without AI.
            </small>
          </div>
        </>
      ) : (
        <div className="studio-card studio-stack">
          <div className="studio-row">
            <h3>Review your CRM blueprint</h3>
            <Button variant="ghost" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
          </div>
          <BlueprintEditor value={draft} onChange={setDraft} />
          <Button
            disabled={create.isPending}
            onClick={() => {
              const parsed = blueprintSchema.safeParse(draft);
              if (!parsed.success)
                return toast.error(parsed.error.issues[0].message);
              create.mutate(parsed.data);
            }}
          >
            {create.isPending ? "Creating your workspace…" : "Create local workspace"}
          </Button>
        </div>
      )}
    </section>
  );
}

function StudioWorkspace({ id, back }: { id: string; back: () => void }) {
  const query = trpc.studio.get.useQuery(
    { workspaceId: id },
    { retry: false, refetchInterval: 15000 }
  );
  const utils = trpc.useUtils();
  const [tab, setTab] = useState("records");
  const [key, setKey] = useState("");
  const [editor, setEditor] = useState<Blueprint>();
  const [preview, setPreview] = useState<{
    revision: number;
    changes: string[];
  }>();
  const refresh = () => {
    void utils.studio.get.invalidate({ workspaceId: id });
    void utils.studio.records.invalidate();
    void utils.studio.list.invalidate();
  };
  const save = trpc.studio.saveBlueprint.useMutation({
    onError: error,
    onSuccess: () => {
      setEditor(undefined);
      setPreview(undefined);
      refresh();
      toast.success("Blueprint saved");
    },
  });
  const check = trpc.studio.previewBlueprint.useMutation({
    onError: error,
    onSuccess: setPreview,
  });
  const w = query.data;
  if (!w)
    return (
      <section className="studio studio-card">
        <Button variant="ghost" onClick={back}>
          Back
        </Button>
        <p role={query.error ? "alert" : undefined}>
          {query.error?.message ?? "Loading workspace…"}
        </p>
      </section>
    );
  const object =
    w.blueprint.objects.find(o => o.key === key) ?? w.blueprint.objects[0];
  return (
    <section className="studio studio-stack">
      <div className="studio-row">
        <Button variant="ghost" onClick={back}>
          <ArrowLeft size={16} />
          Workspaces
        </Button>
        <span className="studio-pill">
          {w.provider} · {w.role} · v{w.revision}
        </span>
        <Button variant="ghost" onClick={refresh}>
          <RefreshCw size={16} />
          Refresh
        </Button>
      </div>
      <div className="studio-banner">
        <div>
          <p className="eyebrow">Your CRM workspace</p>
          <h2>{w.blueprint.name}</h2>
          <p>{w.blueprint.description}</p>
        </div>
        <Database size={38} />
      </div>
      <div className="studio-tabs" role="tablist" aria-label="Studio sections">
        {[
          "records",
          "blueprint",
          "connections",
          "team",
          "activity",
          "MCP",
          "training",
        ].map(t => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "training" && (
        <TrainingLab
          workspaceId={id}
          blueprint={w.blueprint}
          writable={w.role !== "viewer"}
        />
      )}
      {tab === "records" && (
        <>
          <div className="studio-row">
            {w.blueprint.objects.map(o => (
              <Button
                key={o.key}
                variant={object.key === o.key ? "default" : "outline"}
                onClick={() => setKey(o.key)}
              >
                {o.plural}
              </Button>
            ))}
          </div>
          <RecordWorkspace
            key={object.key}
            workspaceId={id}
            object={object}
            writable={w.role !== "viewer"}
            refresh={refresh}
          />
          <ProposalList
            workspaceId={id}
            proposals={w.proposals}
            owner={w.role === "owner"}
            refresh={refresh}
          />
        </>
      )}
      {tab === "blueprint" && (
        <div className="studio-card studio-stack">
          <div className="studio-row">
            <h3>Schema and version history</h3>
            <Button
              variant="outline"
              onClick={() => download("crm-blueprint.json", w.blueprint)}
            >
              <Download size={16} />
              Export blueprint
            </Button>
            {w.role === "owner" && (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    download(
                      "crm-workspace-export.json",
                      await utils.studio.export.fetch({ workspaceId: id })
                    );
                  } catch (e) {
                    error(e as Error);
                  }
                }}
              >
                Export local data & audit
              </Button>
            )}
          </div>
          {w.role === "owner" ? (
            <>
              <BlueprintEditor
                value={editor ?? w.blueprint}
                onChange={b => {
                  setEditor(b);
                  setPreview(undefined);
                }}
              />
              <Button
                disabled={!editor || check.isPending}
                onClick={() =>
                  check.mutate({ workspaceId: id, blueprint: editor! })
                }
              >
                Preview schema changes
              </Button>
              {preview && (
                <div className="studio-review">
                  <h4>Review changes</h4>
                  <ul>
                    {preview.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                  <p>
                    Existing records must remain valid. This changes the Studio
                    schema, not remote provider metadata.
                  </p>
                  <Button
                    disabled={save.isPending}
                    onClick={() =>
                      save.mutate({
                        workspaceId: id,
                        revision: preview.revision,
                        blueprint: editor!,
                      })
                    }
                  >
                    Confirm schema update
                  </Button>
                </div>
              )}
              {w.history.map(v => (
                <div className="studio-row" key={v.revision}>
                  <span>
                    Version {v.revision} · {new Date(v.at).toLocaleString()}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditor(v.blueprint);
                      setPreview(undefined);
                    }}
                  >
                    Load as draft
                  </Button>
                </div>
              ))}
            </>
          ) : (
            <pre className="studio-code">{pretty(w.blueprint)}</pre>
          )}
        </div>
      )}
      {tab === "connections" && (
        <Connections workspaceId={id} w={w} refresh={refresh} />
      )}
      {tab === "team" &&
        (w.role === "owner" ? (
          <Team workspaceId={id} />
        ) : (
          <p>Only the workspace owner can manage members.</p>
        ))}
      {tab === "activity" && (
        <div className="studio-card studio-stack">
          <h3>Audit history</h3>
          {w.audit.map(a => (
            <div key={a.id} className="studio-audit">
              <strong>{a.event}</strong>
              <span>{a.detail}</span>
              <small>
                User {a.userId} · {new Date(a.at).toLocaleString()}
              </small>
            </div>
          ))}
        </div>
      )}
      {tab === "MCP" && (
        <McpSettings workspaceId={id} tokens={w.mcpTokens} refresh={refresh} />
      )}
    </section>
  );
}

function RecordWorkspace({
  workspaceId,
  object,
  writable,
  refresh,
}: {
  workspaceId: string;
  object: Blueprint["objects"][number];
  writable: boolean;
  refresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const [selected, setSelected] = useState<CrmRecord>();
  const [values, setValues] = useState<Values>({});
  const [prompt, setPrompt] = useState("");
  const records = trpc.studio.records.useQuery(
    { workspaceId, object: object.key, search: debouncedSearch },
    { retry: false }
  );
  const draft = trpc.studio.draft.useMutation({
    onError: error,
    onSuccess: () => {
      refresh();
      toast.success("Change ready for review below");
    },
  });
  const plan = trpc.studio.plan.useMutation({
    onError: error,
    onSuccess: data => {
      if (data.clarification) toast.info(data.clarification);
      else {
        refresh();
        toast.success("Voice action ready for review below");
      }
    },
  });
  return (
    <div className="studio-stack">
      <div className="studio-card studio-stack">
        <div className="studio-row">
          <h3>{object.plural}</h3>
          <Input
            aria-label="Search records"
            placeholder="Search first page…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <Button
            variant="outline"
            onClick={() => {
              setSelected(undefined);
              setValues({});
            }}
          >
            New {object.label.toLowerCase()}
          </Button>
        </div>
        {records.error && <p role="alert">{records.error.message}</p>}
        {records.isLoading && <p>Loading records…</p>}
        <div className="studio-table-wrap">
          <table className="studio-data-table">
            <thead>
              <tr>
                {object.fields.slice(0, 5).map(f => (
                  <th key={f.key}>{f.label}</th>
                ))}
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {records.data?.records.map(r => (
                <tr
                  key={r.id}
                  className={`studio-data-row${selected?.id === r.id ? " studio-selected" : ""}`}
                >
                  {object.fields.slice(0, 5).map(f => (
                    <td key={f.key}>{String(r.values[f.key] ?? "—")}</td>
                  ))}
                  <td>
                    <button
                      onClick={() => {
                        setSelected(r);
                        setValues(r.values);
                      }}
                    >
                      Select
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!records.isLoading &&
          !records.error &&
          !records.data?.records.length && (
            <p>
              No matching records. Create your first{" "}
              {object.label.toLowerCase()} below.
            </p>
          )}
        {records.data?.truncated && (
          <p>
            Only the first page is shown. Search is limited to this page for
            Twenty and HubSpot.
          </p>
        )}
      </div>
      {writable && (
        <div className="studio-grid studio-editor-grid">
          <div className="studio-card studio-stack">
            <h3>
              {selected ? `Edit ${object.label}` : `Create ${object.label}`}
            </h3>
            {selected && <small>Selected ID: {selected.id}</small>}
            {object.fields.map(f => (
              <label key={f.key}>
                {f.label}
                {f.required ? " *" : ""}
                {f.type === "boolean" ? (
                  <select
                    value={
                      values[f.key] === undefined || values[f.key] === null
                        ? ""
                        : String(values[f.key])
                    }
                    onChange={e =>
                      setValues({
                        ...values,
                        [f.key]:
                          e.target.value === ""
                            ? null
                            : e.target.value === "true",
                      })
                    }
                  >
                    <option value="">Unset</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : f.type === "select" ? (
                  <select
                    value={String(values[f.key] ?? "")}
                    onChange={e =>
                      setValues({ ...values, [f.key]: e.target.value || null })
                    }
                  >
                    <option value="">Choose…</option>
                    {f.options.map(o => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={
                      f.type === "number"
                        ? "number"
                        : f.type === "date"
                          ? "date"
                          : f.type === "email"
                            ? "email"
                            : "text"
                    }
                    value={String(values[f.key] ?? "")}
                    placeholder={
                      f.type === "relation" ? `${f.target} record ID` : ""
                    }
                    onChange={e =>
                      setValues({
                        ...values,
                        [f.key]:
                          e.target.value === ""
                            ? null
                            : f.type === "number"
                              ? Number(e.target.value)
                              : e.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))}
            <div className="studio-row">
              <Button
                disabled={draft.isPending}
                onClick={() =>
                  draft.mutate({
                    workspaceId,
                    action: {
                      operation: selected ? "update" : "create",
                      object: object.key,
                      recordId: selected?.id,
                      values,
                    },
                  })
                }
              >
                Review {selected ? "update" : "create"}
              </Button>
              {selected && (
                <Button
                  variant="outline"
                  disabled={draft.isPending}
                  onClick={() =>
                    draft.mutate({
                      workspaceId,
                      action: {
                        operation: "delete",
                        object: object.key,
                        recordId: selected.id,
                        values: {},
                      },
                    })
                  }
                >
                  Review deletion
                </Button>
              )}
            </div>
          </div>
          <div className="studio-card studio-stack">
            <Mic size={24} />
            <h3>Tell your CRM what to do</h3>
            <p>
              Speak or type a request for {object.plural.toLowerCase()}. Select
              an exact record before updating or deleting.
            </p>
            <VoiceInput onTranscript={setPrompt} />
            <Textarea
              aria-label="CRM command"
              rows={5}
              value={prompt}
              onChange={e => { setPrompt(e.target.value); plan.reset(); }}
              placeholder={`Create a ${object.label.toLowerCase()}…`}
            />
            <Button
              disabled={plan.isPending || !prompt.trim()}
              onClick={() =>
                plan.mutate({
                  workspaceId,
                  object: object.key,
                  selectedRecordId: selected?.id,
                  prompt,
                })
              }
            >
              {plan.isPending ? "Preparing proposal…" : "Prepare action"}
            </Button>
            {plan.error && <p role="alert">{plan.error.message}</p>}
            {plan.data?.clarification && <p role="status">{plan.data.clarification}</p>}
            <small>
              Uses your local model. Every change is reviewed before execution.
            </small>
          </div>
        </div>
      )}
    </div>
  );
}

function VoiceInput({
  onTranscript,
}: {
  onTranscript: (text: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const transcribe = trpc.voice.transcribe.useMutation({
    onError: error,
    onSuccess: r => onTranscript(r.transcript),
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      const r = recorder.current;
      if (r && r.state !== "inactive") r.stop();
      r?.stream.getTracks().forEach(t => t.stop());
    };
  }, []);
  async function toggle() {
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const r = new MediaRecorder(stream);
      recorder.current = r;
      const chunks: BlobPart[] = [];
      r.ondataavailable = e => chunks.push(e.data);
      r.onstop = async () => {
        clearTimeout(timer.current);
        stream.getTracks().forEach(t => t.stop());
        if (!mounted.current) return;
        setRecording(false);
        const blob = new Blob(chunks, { type: r.mimeType });
        if (blob.size > 16 * 1024 * 1024) {
          toast.error("Recording too large");
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          if (mounted.current)
            transcribe.mutate({
              audioBase64: String(reader.result).split(",")[1],
              mimeType: r.mimeType,
              filename: "studio-voice.webm",
            });
        };
        reader.readAsDataURL(blob);
      };
      r.start();
      setRecording(true);
      timer.current = setTimeout(() => {
        if (r.state === "recording") r.stop();
      }, 60000);
    } catch {
      toast.error(
        "Microphone unavailable. Allow microphone access or type your request."
      );
    }
  }
  return (
    <Button
      variant="outline"
      disabled={transcribe.isPending}
      onClick={() => void toggle()}
    >
      {recording ? <Square size={16} /> : <Mic size={16} />}
      {transcribe.isPending
        ? "Transcribing…"
        : recording
          ? "Stop recording"
          : "Record up to 60 seconds"}
    </Button>
  );
}

async function speak(text: string) {
  try {
    const r = await fetch("/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error();
    const url = URL.createObjectURL(await r.blob());
    const audio = new Audio(url);
    const clean = () => URL.revokeObjectURL(url);
    audio.onended = clean;
    audio.onerror = clean;
    try {
      await audio.play();
    } catch {
      clean();
      throw new Error();
    }
  } catch {
    toast.info("Saved. Speech playback is unavailable.");
  }
}
type WorkspaceData = inferRouterOutputs<AppRouter>["studio"]["get"];
function ProposalList({
  workspaceId,
  proposals,
  owner,
  refresh,
}: {
  workspaceId: string;
  proposals: WorkspaceData["proposals"];
  owner: boolean;
  refresh: () => void;
}) {
  const [deleteText, setDeleteText] = useState("");
  const [spoken, setSpoken] = useState(false);
  const [note, setNote] = useState("");
  const confirm = trpc.studio.confirm.useMutation({
    onError: error,
    onSuccess: r => {
      toast.success(r.message);
      setDeleteText("");
      refresh();
      if (spoken) void speak(r.message);
    },
  });
  const reject = trpc.studio.reject.useMutation({
    onError: error,
    onSuccess: refresh,
  });
  const reconcile = trpc.studio.reconcile.useMutation({
    onError: error,
    onSuccess: refresh,
  });
  return (
    <div className="studio-card studio-stack">
      <div className="studio-row">
        <ShieldCheck size={24} />
        <h3>Review queue & receipts</h3>
        <label className="studio-check">
          <input
            type="checkbox"
            checked={spoken}
            onChange={e => setSpoken(e.target.checked)}
          />
          Speak success receipts
        </label>
      </div>
      {!proposals.length && (
        <p>
          Proposed changes will appear here, including drafts from MCP clients.
        </p>
      )}
      {proposals.slice(0, 20).map(p => (
        <div className="studio-review studio-stack" key={p.id}>
          <div className="studio-row">
            <strong>
              {p.action.operation} · {p.action.object}
            </strong>
            <span className="studio-pill">{p.state}</span>
          </div>
          {p.action.recordId && <small>Record: {p.action.recordId}</small>}
          <div className="studio-grid">
            {p.before && (
              <div>
                <small>Before</small>
                <pre>{pretty(p.before.values)}</pre>
              </div>
            )}
            <div>
              <small>
                {p.action.operation === "delete"
                  ? "Record will be deleted"
                  : "Proposed values"}
              </small>
              <pre>{pretty(p.action.values)}</pre>
            </div>
          </div>
          {p.state === "pending" && (
            <>
              <small>Expires {new Date(p.expires).toLocaleTimeString()}</small>
              {p.action.operation === "delete" && (
                <Input
                  aria-label="Type DELETE"
                  placeholder="Type DELETE"
                  value={deleteText}
                  onChange={e => setDeleteText(e.target.value)}
                />
              )}
              <div className="studio-row">
                <Button
                  disabled={
                    confirm.isPending ||
                    p.expires < Date.now() ||
                    (p.action.operation === "delete" && deleteText !== "DELETE")
                  }
                  onClick={() =>
                    confirm.mutate({
                      workspaceId,
                      proposalId: p.id,
                      deleteText,
                    })
                  }
                >
                  Confirm {p.action.operation}
                </Button>
                <Button
                  variant="outline"
                  disabled={reject.isPending}
                  onClick={() =>
                    reject.mutate({ workspaceId, proposalId: p.id })
                  }
                >
                  Reject
                </Button>
              </div>
            </>
          )}
          {p.result && (
            <p>
              {p.result.message} · ID {p.result.id}
            </p>
          )}
          {p.error && <p role="alert">{p.error}</p>}
          {owner &&
            (p.state === "uncertain" ||
              (p.state === "executing" && p.expires < Date.now())) && (
              <>
                <p>
                  Check the record directly in the provider before resolving
                  this receipt.
                </p>
                <Input
                  aria-label="Reconciliation evidence"
                  placeholder="Describe what you verified in the provider"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                />
                <div className="studio-row">
                  <Button
                    disabled={note.length < 10 || reconcile.isPending}
                    onClick={() =>
                      reconcile.mutate({
                        workspaceId,
                        proposalId: p.id,
                        note,
                        succeeded: true,
                      })
                    }
                  >
                    Verified applied
                  </Button>
                  <Button
                    variant="outline"
                    disabled={note.length < 10 || reconcile.isPending}
                    onClick={() =>
                      reconcile.mutate({
                        workspaceId,
                        proposalId: p.id,
                        note,
                        succeeded: false,
                      })
                    }
                  >
                    Verified not applied
                  </Button>
                </div>
              </>
            )}
        </div>
      ))}
    </div>
  );
}

function Connections({
  workspaceId,
  w,
  refresh,
}: {
  workspaceId: string;
  w: WorkspaceData;
  refresh: () => void;
}) {
  const [provider, setProvider] = useState<ProviderId>(w.provider);
  const [mappings, setMappings] = useState(pretty(w.mappings));
  const [object, setObject] = useState("");
  // Provisioning and saves change the active connection without unmounting this tab.
  useEffect(() => {
    setProvider(w.provider);
    setMappings(pretty(w.mappings));
  }, [w.provider, w.revision]);
  const configure = trpc.studio.configure.useMutation({
    onError: error,
    onSuccess: () => {
      refresh();
      toast.success("Connection settings saved");
    },
  });
  const previewTwenty = trpc.studio.previewTwenty.useMutation({
    onError: error,
    onSuccess: refresh,
  });
  const deployTwenty = trpc.studio.deployTwenty.useMutation({
    onError: e => {
      error(e);
      refresh();
    },
    onSuccess: r => {
      refresh();
      toast.success(r.message);
    },
  });
  const schema = trpc.studio.remoteSchema.useQuery(
    { workspaceId, object: object || undefined, provider },
    { enabled: false, retry: false }
  );
  return (
    <div className="studio-stack">
      <div className="studio-grid">
        {w.connections.map(c => (
          <div className="studio-card studio-stack" key={c.id}>
            <Plug size={24} />
            <h3>{c.id}</h3>
            <span className="studio-pill">
              {c.configured ? "Configuration present" : "Not configured"}
            </span>
            <p>{c.detail}</p>
          </div>
        ))}
      </div>
      <div className="studio-card studio-stack">
        <h3>System of record</h3>
        <p>
          Workspace ID: <code>{workspaceId}</code>
        </p>
        <p>
          Switching providers does not copy records. Local data remains
          available when you switch back.
        </p>
        <select
          aria-label="CRM provider"
          value={provider}
          disabled={w.role !== "owner"}
          onChange={e => {
            const next = e.target.value as ProviderId;
            setProvider(next);
            setMappings(pretty(next === w.provider ? w.mappings : w.providerMappings?.[next] ?? {}));
          }}
        >
          {["local", "twenty", "salesforce", "hubspot"].map(p => (
            <option key={p} disabled={!w.connections.find(c => c.id === p)?.configured}>{p}</option>
          ))}
        </select>
        <label>
          Object and field mappings
          <Textarea
            className="studio-code"
            rows={9}
            value={mappings}
            disabled={w.role !== "owner"}
            onChange={e => setMappings(e.target.value)}
          />
        </label>
        <small>
          Example:{" "}
          {`{"contacts":{"remoteObject":"Contact","fields":{"name":"LastName","email":"Email"}}}`}
        </small>
        {w.role === "owner" && (
          <Button
            disabled={configure.isPending}
            onClick={() => {
              try {
                configure.mutate({
                  workspaceId,
                  revision: w.revision,
                  provider,
                  mappings: JSON.parse(mappings),
                });
              } catch {
                toast.error("Mappings must be valid JSON");
              }
            }}
          >
            Save provider and mappings
          </Button>
        )}
        <div className="studio-row">
          <Input
            placeholder="Optional remote object name"
            aria-label="Remote object"
            value={object}
            onChange={e => setObject(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={schema.isFetching}
            onClick={() => void schema.refetch()}
          >
            Inspect selected provider schema
          </Button>
        </div>
        {schema.error && <p role="alert">{schema.error.message}</p>}
        {schema.data && (
          <pre className="studio-code">{pretty(schema.data)}</pre>
        )}
        {w.role === "owner" && (
          <div className="studio-review studio-stack">
            <h3>Create this CRM in Twenty</h3>
            <p>
              Creates separate custom objects and relations. Email and select
              fields use TEXT in Twenty; Studio validates them. Local records
              are not migrated.
            </p>
            <Button
              variant="outline"
              disabled={
                previewTwenty.isPending ||
                deployTwenty.isPending ||
                w.deployment?.status === "running"
              }
              onClick={() => previewTwenty.mutate({ workspaceId })}
            >
              Preview Twenty provisioning
            </Button>
            {w.deployment && (
              <>
                <p>Status: {w.deployment.status}</p>
                <ul>
                  {w.deployment.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                {w.deployment.completed.map((s, i) => (
                  <p key={i}>✓ {s}</p>
                ))}
                {w.deployment.error && <p role="alert">{w.deployment.error}</p>}
                {w.deployment.status === "preview" && (
                  <Button
                    disabled={deployTwenty.isPending}
                    onClick={() =>
                      deployTwenty.mutate({
                        workspaceId,
                        deploymentId: w.deployment!.id,
                      })
                    }
                  >
                    Confirm creation in Twenty
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
function Team({ workspaceId }: { workspaceId: string }) {
  const members = trpc.studio.members.useQuery({ workspaceId });
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  const save = trpc.studio.setMember.useMutation({
    onError: error,
    onSuccess: () => {
      void members.refetch();
      toast.success("Membership updated");
    },
  });
  return (
    <div className="studio-card studio-stack">
      <h3>Workspace members</h3>
      <p>
        Add an existing application user by their numeric ID. Editors can
        propose changes; viewers can read.
      </p>
      {members.error && <p role="alert">{members.error.message}</p>}
      {members.data?.map(m => (
        <div className="studio-row" key={m.userId}>
          <span>
            {m.name ?? "User"} · ID {m.userId} · {m.role}
          </span>
          {m.role !== "owner" && (
            <Button
              variant="ghost"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ workspaceId, userId: m.userId, role: null })
              }
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      <div className="studio-row">
        <Input
          type="number"
          aria-label="User ID"
          placeholder="User ID"
          value={userId}
          onChange={e => setUserId(e.target.value)}
        />
        <select
          aria-label="Member role"
          value={role}
          onChange={e => setRole(e.target.value as typeof role)}
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <Button
          disabled={save.isPending || !Number(userId)}
          onClick={() =>
            save.mutate({ workspaceId, userId: Number(userId), role })
          }
        >
          Add / update member
        </Button>
      </div>
    </div>
  );
}
function McpSettings({
  workspaceId,
  tokens,
  refresh,
}: {
  workspaceId: string;
  tokens: WorkspaceData["mcpTokens"];
  refresh: () => void;
}) {
  const [token, setToken] = useState("");
  const [canDraft, setCanDraft] = useState(false);
  const issue = trpc.studio.issueMcpToken.useMutation({
    onError: error,
    onSuccess: r => {
      setToken(r.token);
      refresh();
    },
  });
  const revoke = trpc.studio.revokeMcpToken.useMutation({
    onError: error,
    onSuccess: refresh,
  });
  return (
    <div className="studio-card studio-stack">
      <h3>Connect an MCP client</h3>
      <p>
        Use Streamable HTTP at <code>{location.origin}/api/mcp</code> with an
        Authorization: Bearer token header. Tokens expire in 30 days and are
        invalidated by logout or session revocation.
      </p>
      <p>
        Read tools and schema resources are available. Optional draft access
        adds proposed changes to your review queue. Execution stays in CRM
        Studio.
      </p>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={canDraft}
          onChange={e => setCanDraft(e.target.checked)}
        />
        Allow proposing changes
      </label>
      <Button
        disabled={issue.isPending}
        onClick={() => issue.mutate({ workspaceId, canDraft })}
      >
        Create token
      </Button>
      {token && (
        <div className="studio-review">
          <p>
            Copy now. This token will not be shown again after leaving this tab.
          </p>
          <Textarea readOnly aria-label="New MCP token" value={token} />
          <Button variant="ghost" onClick={() => setToken("")}>
            Hide token
          </Button>
        </div>
      )}
      {tokens.map(t => (
        <div className="studio-row" key={t.id}>
          <code>{t.id}</code>
          <span>
            Expires {new Date(t.expires).toLocaleDateString()} ·{" "}
            {t.canDraft ? "Read and draft" : "Read only"}
          </span>
          <Button
            variant="outline"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ workspaceId, tokenId: t.id })}
          >
            Revoke
          </Button>
        </div>
      ))}
    </div>
  );
}
