import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { salesforceRouter } from "../salesforce";
import type { TrpcContext } from "../_core/context";
import type {
  CrmAction,
  CrmRecord,
  Mapping,
  ProviderId,
  Values,
} from "../../shared/crm";
import type { Workspace } from "./store";
import { readTwentyMetadata } from "./twentyMetadata";

export type RemoteSchema = {
  objects: {
    key: string;
    label: string;
    fields: { key: string; label: string; type: string; writable: boolean }[];
  }[];
};
export interface CrmProvider {
  id: ProviderId;
  schema(object?: string): Promise<RemoteSchema>;
  list(
    object: string,
    search: string
  ): Promise<{ records: CrmRecord[]; truncated: boolean }>;
  get(object: string, id: string): Promise<CrmRecord>;
  execute(action: CrmAction): Promise<{ id: string; message: string }>;
}
const safeName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);
const safeId = (id: string) =>
  encodeURIComponent(z.string().min(1).max(100).parse(id));
const object = z.record(z.string(), z.unknown());
const configurationError = (message: string): never => {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
};
export function connectionStatus(w: Workspace) {
  return [
    {
      id: "local" as const,
      configured: true,
      detail: "Custom records stored in your application database",
    },
    {
      id: "twenty" as const,
      configured:
        process.env.TWENTY_WORKSPACE_ID === w.id &&
        configuredValue(process.env.TWENTY_API_URL) && configuredValue(process.env.TWENTY_API_KEY),
      detail: !configuredValue(process.env.TWENTY_API_KEY) || !configuredValue(process.env.TWENTY_API_URL)
        ? "Twenty API URL or API key is missing from the server configuration."
        : process.env.TWENTY_WORKSPACE_ID !== w.id
          ? "Twenty credentials are saved but not assigned to this Studio workspace. Assign this workspace ID on the server."
          : "Credentials assigned to this workspace. Inspect the provider schema to verify access.",
    },
    {
      id: "hubspot" as const,
      configured:
        process.env.HUBSPOT_STUDIO_WORKSPACE_ID === w.id &&
        configuredValue(process.env.HUBSPOT_ACCESS_TOKEN),
      detail: !configuredValue(process.env.HUBSPOT_ACCESS_TOKEN)
        ? "HubSpot access token is missing from the server configuration."
        : process.env.HUBSPOT_STUDIO_WORKSPACE_ID !== w.id
          ? "HubSpot credentials are saved but not assigned to this Studio workspace. Assign this workspace ID on the server."
          : "Credentials assigned to this workspace. Inspect the provider schema to verify access.",
    },
    {
      id: "salesforce" as const,
      configured: [process.env.SALESFORCE_CLIENT_ID, process.env.SALESFORCE_CLIENT_SECRET, process.env.SALESFORCE_LOGIN_URL].every(configuredValue),
      detail: "Connect your own account from the Salesforce tab",
    },
  ];
}
export function configuredValue(value: string | undefined): boolean {
  return Boolean(value?.trim() && !/^(?:REPLACE_|CHANGE_|YOUR_|PLACEHOLDER|<)/i.test(value.trim()));
}
export function remoteSettings(w: Workspace) {
  if (w.provider === "twenty") {
    if (
      process.env.TWENTY_WORKSPACE_ID !== w.id ||
      !configuredValue(process.env.TWENTY_API_KEY) ||
      !configuredValue(process.env.TWENTY_API_URL)
    )
      configurationError(
        "Twenty credentials are not assigned to this workspace"
      );
    const url = new URL(process.env.TWENTY_API_URL!);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(url.hostname)
        ))
    )
      configurationError("Twenty requires HTTPS, or HTTP on localhost / Docker's host gateway");
    return {
      base: url.href.replace(/\/$/, ""),
      token: process.env.TWENTY_API_KEY!,
    };
  }
  if (w.provider === "hubspot") {
    if (
      process.env.HUBSPOT_STUDIO_WORKSPACE_ID !== w.id ||
      !configuredValue(process.env.HUBSPOT_ACCESS_TOKEN)
    )
      configurationError(
        "HubSpot credentials are not assigned to this workspace"
      );
    return {
      base: "https://api.hubapi.com",
      token: process.env.HUBSPOT_ACCESS_TOKEN!,
    };
  }
  return configurationError("This provider has no HTTP configuration");
}
export async function remoteRequest(
  w: Workspace,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  const settings = remoteSettings(w);
  const response = await fetch(`${settings.base}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${settings.token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `${w.provider} returned HTTP ${response.status}. Check connection, permissions and mappings.`,
    });
  }
  return response.status === 204 ? {} : response.json();
}
export function mappedObject(w: Workspace, key: string): Mapping {
  const mapping = w.mappings[key];
  if (!mapping)
    configurationError(`Map ${key} to a remote object in Connections first`);
  safeName.parse(mapping.remoteObject);
  return mapping;
}
function mappedValues(mapping: Mapping, values: Values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const name = mapping.fields[key];
      if (!name) configurationError(`No remote field mapping for ${key}`);
      return [safeName.parse(name), value];
    })
  );
}
function normalized(
  w: Workspace,
  key: string,
  raw: Record<string, unknown>
): CrmRecord {
  const mapping = mappedObject(w, key);
  const source = w.provider === "hubspot" ? object.parse(raw.properties) : raw;
  const definition = w.blueprint.objects.find(o => o.key === key)!;
  const values: Values = {};
  for (const [local, remote] of Object.entries(mapping.fields)) {
    let value = source[remote];
    const field = definition.fields.find(f => f.key === local);
    if (value === undefined || value === null || value === "") {
      values[local] = null;
      continue;
    }
    if (
      field?.type === "number" &&
      typeof value === "string" &&
      Number.isFinite(Number(value))
    )
      value = Number(value);
    if (field?.type === "boolean" && ["true", "false"].includes(String(value)))
      value = String(value) === "true";
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      values[local] = value;
    else
      configurationError(
        `Field ${remote} is composite; map a scalar field instead`
      );
  }
  return {
    id: String(raw.id ?? raw.Id),
    object: key,
    values,
    version: 0,
    updatedAt: String(raw.updatedAt ?? ""),
  };
}
export function remoteProvider(w: Workspace, ctx: TrpcContext): CrmProvider {
  const sf = salesforceRouter.createCaller(ctx);
  const path = (key: string, id?: string) =>
    `${w.provider === "twenty" ? "/rest/" : "/crm/v3/objects/"}${mappedObject(w, key).remoteObject}${id ? `/${safeId(id)}` : ""}`;
  const get = async (key: string, id: string) => {
    if (w.provider === "salesforce")
      return normalized(
        w,
        key,
        (await sf.getRecord({ object: mappedObject(w, key).remoteObject, id }))
          .record
      );
    const query =
      w.provider === "hubspot"
        ? `?properties=${Object.values(mappedObject(w, key).fields).join(",")}`
        : "";
    const raw = object.parse(await remoteRequest(w, path(key, id) + query));
    return normalized(
      w,
      key,
      w.provider === "twenty"
        ? object.parse(Object.values(object.parse(raw.data))[0])
        : raw
    );
  };
  return {
    id: w.provider,
    async schema(name) {
      if (name) safeName.parse(name);
      if (w.provider === "salesforce") {
        if (!name)
          return {
            objects: (await sf.objects()).map(o => ({
              key: o.name,
              label: o.label,
              fields: [],
            })),
          };
        const o = await sf.describeObject({ object: name });
        return {
          objects: [
            {
              key: o.name,
              label: o.label,
              fields: o.fields.map(f => ({
                key: f.name,
                label: f.label,
                type: f.type,
                writable: f.createable || f.updateable,
              })),
            },
          ],
        };
      }
      if (w.provider === "hubspot") {
        if (!name)
          return {
            objects: ["contacts", "companies", "deals", "tasks", "notes"].map(
              key => ({ key, label: key, fields: [] })
            ),
          };
        const raw = z
          .object({
            results: z.array(
              z.object({
                name: z.string(),
                label: z.string(),
                type: z.string(),
                modificationMetadata: z
                  .object({ readOnlyValue: z.boolean().optional() })
                  .optional(),
              })
            ),
          })
          .parse(await remoteRequest(w, `/crm/v3/properties/${name}`));
        return {
          objects: [
            {
              key: name,
              label: name,
              fields: raw.results.map(f => ({
                key: f.name,
                label: f.label,
                type: f.type,
                writable: !f.modificationMetadata?.readOnlyValue,
              })),
            },
          ],
        };
      }
      const entries = await readTwentyMetadata(w);
      return {
        objects: entries
          .filter(o => !name || o.namePlural === name)
          .map(o => ({
            key: o.namePlural,
            label: o.labelPlural,
            fields: (o.fields ?? []).map(f => ({
              key: f.name,
              label: f.label,
              type: f.type,
              writable: !f.isSystem,
            })),
          })),
      };
    },
    async list(key, search) {
      if (w.provider === "salesforce") {
        const result = await sf.listRecords({
          object: mappedObject(w, key).remoteObject,
          search,
        });
        // Retrieve only the first page, preserving remote permissions on every read.
        return {
          records: await Promise.all(
            result.records.slice(0, 20).map(r => get(key, r.Id))
          ),
          truncated: result.truncated || result.records.length > 20,
        };
      }
      const query =
        w.provider === "twenty"
          ? "?limit=50&depth=0"
          : `?limit=50&properties=${Object.values(mappedObject(w, key).fields).join(",")}`;
      const raw = object.parse(await remoteRequest(w, path(key) + query));
      const entries = z
        .array(object)
        .parse(
          w.provider === "twenty"
            ? object.parse(raw.data)[mappedObject(w, key).remoteObject]
            : raw.results
        );
      const records = entries.map(row => normalized(w, key, row));
      return {
        records: records.filter(
          r =>
            !search ||
            JSON.stringify(r.values)
              .toLowerCase()
              .includes(search.toLowerCase())
        ),
        truncated: entries.length >= 50,
      };
    },
    get,
    async execute(action) {
      const mapping = mappedObject(w, action.object);
      const values = mappedValues(mapping, action.values);
      if (w.provider === "salesforce") {
        const draft = await sf.prepareChange({
          object: mapping.remoteObject,
          operation: action.operation,
          id: action.recordId,
          ...(action.operation === "delete" ? {} : { fields: values }),
        });
        const result = await sf.confirmChange({ token: draft.token });
        return {
          id: result.id ?? action.recordId!,
          message: `Salesforce ${action.operation} completed`,
        };
      }
      const raw = object.parse(
        await remoteRequest(
          w,
          path(action.object, action.recordId),
          action.operation === "create"
            ? "POST"
            : action.operation === "update"
              ? "PATCH"
              : "DELETE",
          action.operation === "delete"
            ? undefined
            : w.provider === "twenty"
              ? values
              : { properties: values }
        )
      );
      const record =
        w.provider === "twenty" && raw.data
          ? object.parse(Object.values(object.parse(raw.data))[0])
          : raw;
      return {
        id: String(record.id ?? action.recordId ?? ""),
        message: `${w.provider} ${action.operation} completed`,
      };
    },
  };
}
