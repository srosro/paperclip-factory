import { and, eq } from "drizzle-orm";
import { messagingLabelRefs } from "@paperclipai/db";
import type { Db } from "../../router.js";

export interface EnsureLinearLabelRefArgs {
  db: Db;
  companyId: string;
  paperclipLabelId: string;
}

/**
 * Look up a Linear label UUID for a Paperclip label. If none exists yet,
 * invoke `createOnRemote` to create the label in Linear and persist the
 * correspondence.
 */
export async function ensureLinearLabelRef(
  args: EnsureLinearLabelRefArgs,
  createOnRemote: () => Promise<string>,
): Promise<string> {
  const existing = await args.db
    .select({ externalLabelRef: messagingLabelRefs.externalLabelRef })
    .from(messagingLabelRefs)
    .where(
      and(
        eq(messagingLabelRefs.paperclipLabelId, args.paperclipLabelId),
        eq(messagingLabelRefs.backend, "linear"),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].externalLabelRef;

  const externalRef = await createOnRemote();
  await args.db
    .insert(messagingLabelRefs)
    .values({
      companyId: args.companyId,
      backend: "linear",
      paperclipLabelId: args.paperclipLabelId,
      externalLabelRef: externalRef,
    })
    .onConflictDoNothing({
      target: [messagingLabelRefs.paperclipLabelId, messagingLabelRefs.backend],
    });
  return externalRef;
}

export async function findLinearLabelByExternalRef(
  db: Db,
  companyId: string,
  externalLabelRef: string,
) {
  const [row] = await db
    .select()
    .from(messagingLabelRefs)
    .where(
      and(
        eq(messagingLabelRefs.companyId, companyId),
        eq(messagingLabelRefs.backend, "linear"),
        eq(messagingLabelRefs.externalLabelRef, externalLabelRef),
      ),
    )
    .limit(1);
  return row;
}
