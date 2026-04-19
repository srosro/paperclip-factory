import { eq, and, inArray } from "drizzle-orm";
import { agents, messagingIdentities } from "@paperclipai/db";
import type { Db } from "../../router.js";
import { fromGfm, toGfm } from "./mrkdwn.js";

const MENTION_RE = /\B@([A-Za-z0-9._-]+)/g;
const SLACK_MENTION_RE = /<@([A-Z0-9_]+)>/g;

/**
 * Outbound: agent body uses `@claudecoder`. Rewrite to Slack-native `<@U…>`
 * tokens by looking up the backend identity for each name.
 */
export async function toExternalMentions(
  db: Db,
  companyId: string,
  body: string,
): Promise<string> {
  const names = Array.from(body.matchAll(MENTION_RE), (m) => m[1]).filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
  if (names.length === 0) return body;

  const rows = await db
    .select({
      agentName: agents.name,
      externalRef: messagingIdentities.externalUserRef,
    })
    .from(messagingIdentities)
    .innerJoin(agents, eq(messagingIdentities.agentId, agents.id))
    .where(
      and(
        eq(messagingIdentities.backend, "slack"),
        eq(messagingIdentities.companyId, companyId),
        inArray(agents.name, [...new Set(names)]),
      ),
    );
  const byName = new Map(rows.map((r) => [r.agentName, r.externalRef]));

  return body.replace(MENTION_RE, (_full, name: string) => {
    const ext = byName.get(name);
    return ext ? `<@${ext}>` : `@${name}`;
  });
}

export interface InternalMentionResult {
  rewritten: string;
  mentionedAgentIds: string[];
  mentionedUserIds: string[];
}

/**
 * Inbound: Slack payload carries `<@U…>` references. Rewrite to Paperclip's
 * `@name` form for index/UI storage, and return the resolved Paperclip agent
 * ids for wake dispatch + user ids for inbox dispatch.
 */
export async function toInternalMentions(
  db: Db,
  body: string,
): Promise<InternalMentionResult> {
  const refs = Array.from(body.matchAll(SLACK_MENTION_RE), (m) => m[1]).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );
  if (refs.length === 0) {
    return { rewritten: body, mentionedAgentIds: [], mentionedUserIds: [] };
  }

  const rows = await db
    .select({
      externalRef: messagingIdentities.externalUserRef,
      agentId: messagingIdentities.agentId,
      userId: messagingIdentities.userId,
      agentName: agents.name,
    })
    .from(messagingIdentities)
    .leftJoin(agents, eq(messagingIdentities.agentId, agents.id))
    .where(
      and(
        eq(messagingIdentities.backend, "slack"),
        inArray(messagingIdentities.externalUserRef, [...new Set(refs)]),
      ),
    );
  const byRef = new Map(rows.map((r) => [r.externalRef, r]));

  const rewritten = body.replace(SLACK_MENTION_RE, (_full, ref: string) => {
    const row = byRef.get(ref);
    return row?.agentName ? `@${row.agentName}` : `<@${ref}>`;
  });

  const mentionedAgentIds = rows
    .map((r) => r.agentId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const mentionedUserIds = rows
    .map((r) => r.userId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return { rewritten, mentionedAgentIds, mentionedUserIds };
}

/**
 * Convenience used by the events module: pass raw body, get back the agent
 * ids + user ids mentioned. Always backend=slack; the router-agnostic form is
 * `resolveMentions(rawBody)` in `EventsDeps`.
 */
export async function resolveSlackMentions(
  db: Db,
  rawBody: string,
): Promise<{ agentIds: string[]; userIds: string[] }> {
  const { mentionedAgentIds, mentionedUserIds } = await toInternalMentions(
    db,
    rawBody,
  );
  return { agentIds: mentionedAgentIds, userIds: mentionedUserIds };
}

/**
 * Match Slack-style pseudo-link emitted by agents: `<path|label>` where path
 * is absolute (starts with `/`). Slack only renders `<url|label>` when the
 * first part is an actual URL, so these show up as raw text otherwise.
 */
const INTERNAL_PSEUDO_LINK_RE = /<(\/[^|>\s]+)\|([^>]+)>/g;

function rewritePseudoLinks(body: string, publicBaseUrl: string): string {
  const trimmed = publicBaseUrl.replace(/\/+$/, "");
  return body.replace(INTERNAL_PSEUDO_LINK_RE, (_full, path: string, label: string) => {
    return `<${trimmed}${path}|${label}>`;
  });
}

/**
 * Outbound body rewrite combining GFM→mrkdwn translation, @name→<@Uxxx>
 * mention resolution, and internal-path link expansion. Drop-in for
 * `SlackDeps.rewriteOutboundBody`. The optional publicBaseUrl is used to
 * promote agent-emitted `</path|label>` references to fully-qualified
 * `<https://host/path|label>` so Slack renders them as links.
 */
export async function rewriteOutboundBodyForSlack(
  db: Db,
  companyId: string,
  body: string,
  publicBaseUrl?: string,
): Promise<string> {
  const withMentions = await toExternalMentions(db, companyId, body);
  const withLinks = publicBaseUrl
    ? rewritePseudoLinks(withMentions, publicBaseUrl)
    : withMentions;
  return fromGfm(withLinks);
}

/**
 * Inbound body rewrite to canonical GFM form. Useful for UIs and indexes that
 * need a backend-neutral rendering; Phase 1 doesn't persist bodies so this is
 * called on-demand.
 */
export function rewriteInboundBodyFromSlack(body: string): string {
  return toGfm(body);
}
