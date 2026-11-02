import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { remoteRequest } from "./providers";
import { readTwentyMetadata, twentyObject } from "./twentyMetadata";
import { audit, denied, studioStore, type Workspace } from "./store";
import type { Mapping } from "../../shared/crm";

export type Deployment = {
  id: string;
  revision: number;
  status: "preview" | "running" | "succeeded" | "failed";
  expires: number;
  steps: string[];
  completed: string[];
  error?: string;
};
const names = (w: Workspace, key: string) => {
  const singular = `lv${w.id.replace(/-/g, "").slice(0, 8)}${key[0].toUpperCase()}${key.slice(1)}Record`;
  return { nameSingular: singular, namePlural: `${singular}s` };
};
const twentyType = (type: string) =>
  ({
    number: "NUMBER",
    boolean: "BOOLEAN",
    date: "DATE",
    relation: "RELATION",
  })[type] ?? "TEXT";
const marker = (w: Workspace) => `Managed by LocalVoice workspace ${w.id}`;
function owned(w: Workspace, object: z.infer<typeof twentyObject>) {
  if (object.description !== marker(w))
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "A matching Twenty object belongs to another configuration. No changes were applied to it.",
    });
}
export async function previewDeployment(userId: number, id: string) {
  const { workspace: w, role } = await studioStore.read(userId, id);
  if (role !== "owner") denied();
  const remote = await readTwentyMetadata(w);
  const steps: string[] = [];
  for (const o of w.blueprint.objects) {
    const found = remote.find(r => r.namePlural === names(w, o.key).namePlural);
    if (found) owned(w, found);
    else steps.push(`Create custom object: ${o.label}`);
    for (const f of o.fields) {
      const existing = found?.fields.find(r => r.name === f.key);
      if (existing && existing.type !== twentyType(f.type))
        throw new TRPCError({
          code: "CONFLICT",
          message: `Twenty field ${o.key}.${f.key} has an incompatible type`,
        });
      if (!existing)
        steps.push(`Create ${o.label}.${f.label} (${twentyType(f.type)})`);
    }
  }
  return studioStore.mutate(userId, id, ["owner"], current => {
    if (
      current.revision !== w.revision ||
      current.deployment?.status === "running"
    )
      throw new TRPCError({
        code: "CONFLICT",
        message: "Workspace changed or deployment running",
      });
    const deployment: Deployment = {
      id: randomUUID(),
      revision: w.revision,
      status: "preview",
      expires: Date.now() + 10 * 60000,
      steps,
      completed: [],
    };
    current.deployment = deployment;
    audit(current, userId, "deployment.previewed", deployment.id);
    return deployment;
  });
}
export async function deployTwenty(
  userId: number,
  id: string,
  deploymentId: string
) {
  const w = await studioStore.mutate(userId, id, ["owner"], w => {
    const d = w.deployment;
    if (
      !d ||
      d.id !== deploymentId ||
      d.status !== "preview" ||
      d.revision !== w.revision ||
      d.expires < Date.now() ||
      w.proposals.some(p => ["executing", "uncertain"].includes(p.state))
    )
      throw new TRPCError({
        code: "CONFLICT",
        message: "Preview expired or another operation needs attention",
      });
    d.status = "running";
    audit(w, userId, "deployment.started", d.id);
    return structuredClone(w);
  });
  const remoteWorkspace = { ...w, provider: "twenty" as const };
  const request = (path: string, body: unknown) =>
    remoteRequest(remoteWorkspace, path, "POST", body);
  const completed = async (step: string) =>
    studioStore.mutate(userId, id, ["owner"], current => {
      current.deployment!.completed.push(step);
    });
  try {
    let remote = await readTwentyMetadata(w);
    const mappings: Record<string, Mapping> = {};
    for (const o of w.blueprint.objects) {
      const naming = names(w, o.key);
      let found = remote.find(r => r.namePlural === naming.namePlural);
      if (found) owned(w, found);
      else {
        const raw = await request("/rest/metadata/objects", {
          ...naming,
          labelSingular: o.label,
          labelPlural: o.plural,
          description: marker(w),
          skipNameField: true,
        });
        const envelope = z.record(z.string(), z.unknown()).parse(raw);
        const data = envelope.data
          ? z.record(z.string(), z.unknown()).parse(envelope.data)
              .createOneObject
          : raw;
        found = twentyObject.parse(data);
        remote.push(found);
        await completed(`Created ${o.label}`);
      }
      mappings[o.key] = { remoteObject: naming.namePlural, fields: {} };
    }
    // All targets exist before relation fields are created.
    for (const o of w.blueprint.objects) {
      const target = remote.find(
        r => r.namePlural === names(w, o.key).namePlural
      )!;
      for (const f of o.fields) {
        const existing = target.fields.find(r => r.name === f.key);
        if (existing && existing.type !== twentyType(f.type))
          throw new Error("Existing remote field has incompatible type");
        if (!existing) {
          await request("/rest/metadata/fields", {
            objectMetadataId: target.id,
            name: f.key,
            label: f.label,
            type: twentyType(f.type),
            isNullable: true,
            ...(f.type === "relation"
              ? {
                  relationCreationPayload: {
                    type: "MANY_TO_ONE",
                    targetObjectMetadataId: remote.find(
                      r => r.namePlural === names(w, f.target!).namePlural
                    )!.id,
                    targetFieldLabel: `${o.plural} ${f.label}`,
                    targetFieldIcon: "IconLink",
                  },
                }
              : {}),
          });
          await completed(`Created ${o.label}.${f.label}`);
        }
        mappings[o.key].fields[f.key] =
          f.type === "relation" ? `${f.key}Id` : f.key;
      }
    }
    // A read-after-write verifies every field before activating the mapping.
    remote = await readTwentyMetadata(w);
    for (const o of w.blueprint.objects)
      for (const f of o.fields)
        if (
          !remote
            .find(r => r.namePlural === mappings[o.key].remoteObject)
            ?.fields.some(
              r => r.name === f.key && r.type === twentyType(f.type)
            )
        )
          throw new Error("Remote metadata verification failed");
    await studioStore.mutate(userId, id, ["owner"], current => {
      current.providerMappings ??= {};
      current.providerMappings[current.provider] = structuredClone(current.mappings);
      current.providerMappings.twenty = structuredClone(mappings);
      current.mappings = mappings;
      current.provider = "twenty";
      current.revision++;
      current.deployment!.status = "succeeded";
      audit(current, userId, "deployment.succeeded", deploymentId);
    });
    return {
      message:
        "Twenty schema created and verified. Workspace now uses Twenty. Local records were not copied.",
    };
  } catch {
    await studioStore.mutate(userId, id, ["owner"], current => {
      current.deployment!.status = "failed";
      current.deployment!.error =
        "Deployment stopped. Inspect Twenty and preview again to reconcile existing objects and resume missing fields.";
      audit(current, userId, "deployment.failed", deploymentId);
    });
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message:
        "Deployment stopped. Partial objects may exist in Twenty. Preview again to reconcile them; no automatic retries were made.",
    });
  }
}
