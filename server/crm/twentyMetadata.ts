import { z } from "zod";
import { remoteRequest } from "./providers";
import type { Workspace } from "./store";

export const twentyField = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  type: z.string(),
  isSystem: z.boolean().optional(),
});
export const twentyObject = z.object({
  id: z.string(),
  nameSingular: z.string(),
  namePlural: z.string(),
  labelPlural: z.string(),
  description: z.string().nullable().optional(),
  fields: z.array(twentyField).default([]),
});
export function parseTwentyMetadataPage(raw: unknown) {
  const envelope = z
    .object({
      data: z.unknown(),
      pageInfo: z
        .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
        .optional(),
    })
    .parse(raw);
  return {
    objects: z
      .array(twentyObject)
      .parse(
        Array.isArray(envelope.data)
          ? envelope.data
          : z.object({ objects: z.unknown() }).parse(envelope.data).objects
      ),
    next: envelope.pageInfo?.hasNextPage ? envelope.pageInfo.endCursor : null,
  };
}
export async function readTwentyMetadata(w: Workspace) {
  const objects: z.infer<typeof twentyObject>[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = parseTwentyMetadataPage(
      await remoteRequest(
        { ...w, provider: "twenty" },
        `/rest/metadata/objects?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`
      )
    );
    objects.push(...result.objects);
    if (!result.next) return objects;
    if (cursors.has(result.next))
      throw new Error("Twenty returned a repeated metadata cursor");
    cursors.add(result.next);
    after = result.next;
  }
  throw new Error("Twenty metadata exceeds supported page limit");
}
