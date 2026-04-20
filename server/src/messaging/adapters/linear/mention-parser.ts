import { and, eq, inArray } from "drizzle-orm";
import { messagingIdentities } from "@paperclipai/db";
import type { Db } from "../../router.js";
import { extractLinearMentions } from "./events-normalize.js";

export async function resolveLinearMentions(
  db: Db,
  companyId: string,
  body: string,
): Promise<{ agentIds: string[] }> {
  const refs = extractLinearMentions(body);
  if (refs.length === 0) return { agentIds: [] };
  const rows = await db
    .select({ agentId: messagingIdentities.agentId })
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.backend, "linear"),
        eq(messagingIdentities.companyId, companyId),
        inArray(messagingIdentities.externalUserRef, refs),
      ),
    );
  return {
    agentIds: rows
      .map((r) => r.agentId)
      .filter((a): a is string => !!a),
  };
}
