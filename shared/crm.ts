import { z } from "zod";

export const crmKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  .refine(
    v =>
      ![
        "constructor",
        "prototype",
        "__proto__",
        "id",
        "createdAt",
        "updatedAt",
      ].includes(v),
    "Reserved name"
  );
export const fieldDefinition = z.object({
  key: crmKey,
  label: z.string().trim().min(1).max(100),
  type: z.enum([
    "text",
    "number",
    "boolean",
    "date",
    "email",
    "select",
    "relation",
  ]),
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(100)).max(100).default([]),
  target: crmKey.optional(),
  aliases: z.array(z.string().min(1).max(80)).max(20).default([]),
});
export const objectDefinition = z.object({
  key: crmKey,
  label: z.string().trim().min(1).max(100),
  plural: z.string().trim().min(1).max(100),
  fields: z.array(fieldDefinition).min(1).max(50),
  aliases: z.array(z.string().min(1).max(80)).max(20).default([]),
});
export const blueprintSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(""),
    objects: z.array(objectDefinition).min(1).max(20),
  })
  .superRefine((b, ctx) => {
    if (new Set(b.objects.map(o => o.key)).size !== b.objects.length)
      ctx.addIssue({
        code: "custom",
        message: "Object keys must be unique",
        path: ["objects"],
      });
    for (const [i, o] of b.objects.entries()) {
      if (new Set(o.fields.map(f => f.key)).size !== o.fields.length)
        ctx.addIssue({
          code: "custom",
          message: "Field keys must be unique",
          path: ["objects", i, "fields"],
        });
      for (const [j, f] of o.fields.entries()) {
        if (
          f.type === "relation" &&
          !b.objects.some(target => target.key === f.target)
        )
          ctx.addIssue({
            code: "custom",
            message: "Relation target must exist",
            path: ["objects", i, "fields", j],
          });
        if (
          f.type === "select" &&
          (!f.options.length || new Set(f.options).size !== f.options.length)
        )
          ctx.addIssue({
            code: "custom",
            message: "Select choices must be nonempty and unique",
            path: ["objects", i, "fields", j],
          });
      }
    }
  });
export type Blueprint = z.infer<typeof blueprintSchema>;
export type CrmObject = Blueprint["objects"][number];
export const valuesSchema = z
  .record(
    crmKey,
    z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()])
  )
  .refine(v => Object.keys(v).length <= 50);
export type Values = z.infer<typeof valuesSchema>;
export const actionSchema = z
  .object({
    operation: z.enum(["create", "update", "delete"]),
    object: crmKey,
    recordId: z.string().min(1).max(100).optional(),
    values: valuesSchema.default({}),
  })
  .superRefine((a, c) => {
    if (a.operation !== "create" && !a.recordId)
      c.addIssue({ code: "custom", message: "Select an exact record first" });
    if (a.operation === "delete" && Object.keys(a.values).length)
      c.addIssue({ code: "custom", message: "Delete cannot contain values" });
  });
export type CrmAction = z.infer<typeof actionSchema>;
export const providerSchema = z.enum([
  "local",
  "twenty",
  "salesforce",
  "hubspot",
]);
export type ProviderId = z.infer<typeof providerSchema>;
export type CrmRecord = {
  id: string;
  object: string;
  values: Values;
  version: number;
  updatedAt: string;
  deletedAt?: string | null;
};
export type Mapping = { remoteObject: string; fields: Record<string, string> };
export const mappingSchema = z.record(
  crmKey,
  z.object({
    remoteObject: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/),
    fields: z.record(crmKey, z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/)),
  })
);

export function validateValues(
  object: CrmObject,
  values: Values,
  complete = false
) {
  valuesSchema.parse(values);
  for (const key of Object.keys(values))
    if (!object.fields.some(f => f.key === key))
      throw new Error(`Unknown field: ${key}`);
  for (const f of object.fields) {
    const value = values[f.key];
    if (value === undefined && !complete) continue;
    if (value === null || value === undefined || value === "") {
      if (f.required) throw new Error(`${f.label} is required`);
      continue;
    }
    if (
      f.type === "number"
        ? typeof value !== "number"
        : f.type === "boolean"
          ? typeof value !== "boolean"
          : typeof value !== "string"
    )
      throw new Error(`${f.label} needs ${f.type}`);
    if (f.type === "select" && !f.options.includes(String(value)))
      throw new Error(`${f.label}: choose ${f.options.join(", ")}`);
    if (f.type === "email" && !z.email().safeParse(value).success)
      throw new Error(`${f.label} needs a valid email`);
    if (
      f.type === "date" &&
      (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw new Error(`${f.label} needs a real YYYY-MM-DD date`);
  }
  return values;
}

const text = (key: string, label: string, required = false) => ({
  key,
  label,
  type: "text",
  required,
});
const twentyTemplates: { id: string; blueprint: Blueprint }[] = [
  {
    id: "twenty-real-estate",
    blueprint: blueprintSchema.parse({
      name: "Twenty Real Estate — local adaptation",
      description: "Adapted from Twenty's official internal real-estate app. Properties and showings; address, currency, date-time and rich text are simplified. Photos, custom views and automations are not included.",
      objects: [
        { key: "properties", label: "Property", plural: "Properties", fields: [
          text("name", "Name", true), text("propertyAddress", "Address"),
          { key: "price", label: "Price (enter in your chosen currency)", type: "number" },
          { key: "status", label: "Status", type: "select", options: ["COMING_SOON", "ACTIVE", "UNDER_OFFER", "SOLD"] },
          { key: "propertyType", label: "Property type", type: "select", options: ["APARTMENT", "HOUSE", "CONDO", "LAND"] },
          { key: "bedrooms", label: "Bedrooms", type: "number" },
          { key: "bathrooms", label: "Bathrooms", type: "number" },
          { key: "surfaceSqm", label: "Surface (sqm)", type: "number" },
        ] },
        { key: "showings", label: "Showing", plural: "Showings", fields: [
          text("name", "Name", true), text("scheduledAt", "Scheduled at (ISO date and time)"),
          { key: "status", label: "Status", type: "select", options: ["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"] },
          text("feedback", "Feedback"),
          { key: "interestLevel", label: "Interest level", type: "select", options: ["1", "2", "3", "4", "5"] },
        ] },
      ],
    }),
  },
];
export const crmTemplates: { id: string; blueprint: Blueprint }[] = [
  {
    id: "sales",
    blueprint: blueprintSchema.parse({
      name: "Sales CRM",
      description: "Companies, customers, deals and follow-ups.",
      objects: [
        {
          key: "companies",
          label: "Company",
          plural: "Companies",
          fields: [text("name", "Name", true), text("industry", "Industry")],
        },
        {
          key: "contacts",
          label: "Contact",
          plural: "Contacts",
          aliases: ["customer", "pelanggan"],
          fields: [
            text("name", "Name", true),
            { key: "email", label: "Email", type: "email" },
            {
              key: "company",
              label: "Company",
              type: "relation",
              target: "companies",
            },
            text("notes", "Notes"),
          ],
        },
        {
          key: "deals",
          label: "Deal",
          plural: "Deals",
          fields: [
            text("name", "Name", true),
            { key: "amount", label: "Amount", type: "number" },
            {
              key: "stage",
              label: "Stage",
              type: "select",
              options: ["New", "Qualified", "Proposal", "Won", "Lost"],
            },
          ],
        },
        {
          key: "tasks",
          label: "Task",
          plural: "Tasks",
          fields: [
            text("title", "Title", true),
            { key: "dueDate", label: "Due date", type: "date" },
            { key: "completed", label: "Completed", type: "boolean" },
            {
              key: "contact",
              label: "Contact",
              type: "relation",
              target: "contacts",
            },
          ],
        },
      ],
    }),
  },
  {
    id: "property",
    blueprint: blueprintSchema.parse({
      name: "Property Management",
      description: "Properties, tenants and maintenance requests.",
      objects: [
        {
          key: "properties",
          label: "Property",
          plural: "Properties",
          fields: [text("name", "Name", true), text("address", "Address")],
        },
        {
          key: "tenants",
          label: "Tenant",
          plural: "Tenants",
          fields: [
            text("name", "Name", true),
            {
              key: "property",
              label: "Property",
              type: "relation",
              target: "properties",
            },
          ],
        },
        {
          key: "requests",
          label: "Maintenance request",
          plural: "Maintenance requests",
          fields: [
            text("title", "Title", true),
            text("description", "Description"),
            {
              key: "priority",
              label: "Priority",
              type: "select",
              options: ["Normal", "Urgent"],
            },
            {
              key: "tenant",
              label: "Tenant",
              type: "relation",
              target: "tenants",
            },
            { key: "completed", label: "Completed", type: "boolean" },
          ],
        },
      ],
    }),
  },
  {
    id: "recruitment",
    blueprint: blueprintSchema.parse({
      name: "Recruitment",
      description: "Candidates, jobs and applications.",
      objects: [
        {
          key: "candidates",
          label: "Candidate",
          plural: "Candidates",
          fields: [
            text("name", "Name", true),
            { key: "email", label: "Email", type: "email" },
            text("skills", "Skills"),
          ],
        },
        {
          key: "jobs",
          label: "Job",
          plural: "Jobs",
          fields: [text("title", "Title", true), text("employer", "Employer")],
        },
        {
          key: "applications",
          label: "Application",
          plural: "Applications",
          fields: [
            {
              key: "candidate",
              label: "Candidate",
              type: "relation",
              target: "candidates",
              required: true,
            },
            {
              key: "job",
              label: "Job",
              type: "relation",
              target: "jobs",
              required: true,
            },
            {
              key: "stage",
              label: "Stage",
              type: "select",
              options: ["Applied", "Interview", "Offer", "Hired", "Rejected"],
            },
          ],
        },
      ],
    }),
  },
  ...twentyTemplates,
];
