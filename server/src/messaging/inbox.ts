import { and, eq } from "drizzle-orm";
import {
  authUsers,
  issues as issuesTable,
  messagingChannels,
  messagingIdentities,
  messagingWorkspaceInstall,
} from "@paperclipai/db";
import { slackClient, withRetry } from "./adapters/slack/client.js";
import type { Db } from "./router.js";

/**
 * Per-human "paperclip-inbox" DM service.
 *
 * Responsibilities:
 *  - Auto-discover Paperclip users whose emails match Slack workspace users,
 *    creating `messaging_identities` rows so dispatch can find them.
 *  - Resolve / open a DM channel per user and persist it as a `messaging_channels`
 *    row with `purpose='inbox'`.
 *  - Dispatch normalized inbox events (assignment / mention / approval / status
 *    change) as Block Kit messages in the DM, with a 2-minute dedup window —
 *    if we posted about the same issue recently, we edit the existing message
 *    in place with a rolled-up summary instead of spamming a new one.
 *  - Respect per-identity subscription preferences stored in
 *    `messaging_identities.inbox_preferences` jsonb.
 *
 * Inbox posts are "write-only" from Paperclip's side: we never re-ingest them
 * back through the events processor. Dedup state lives in
 * `messaging_channels.metadata`, not in `messaging_message_refs`.
 */

const BACKEND = "slack" as const;
const DEDUP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

// ---- Event types ----------------------------------------------------------

export type InboxEventKind =
  | "assignment"
  | "mention"
  | "approval_requested"
  | "status_change";

export type InboxEvent =
  | {
      kind: "assignment";
      issueId: string;
      fromAgentName?: string | null;
      fromUserName?: string | null;
      priority?: string | null;
    }
  | {
      kind: "mention";
      issueId: string;
      fromDisplayName: string;
      commentRefId: string;
    }
  | {
      kind: "approval_requested";
      approvalId: string;
      issueId?: string | null;
      summary: string;
    }
  | {
      kind: "status_change";
      issueId: string;
      newStatus: string;
    };

export interface InboxPreferences {
  assignment?: boolean;
  mention?: boolean;
  approval_requested?: boolean;
  status_change?: boolean;
  watching?: boolean;
}

const DEFAULT_PREFS: Required<InboxPreferences> = {
  assignment: true,
  mention: true,
  approval_requested: true,
  status_change: true,
  watching: false,
};

// ---- Slack API surface used by inbox (injectable for tests) ---------------

export interface SlackInboxApi {
  usersList(botToken: string): Promise<Array<{ id: string; email: string | null }>>;
  conversationsOpen(botToken: string, userId: string): Promise<{ channelId: string }>;
  postMessage(
    botToken: string,
    args: { channel: string; text: string; blocks?: unknown },
  ): Promise<{ ts: string }>;
  updateMessage(
    botToken: string,
    args: { channel: string; ts: string; text: string; blocks?: unknown },
  ): Promise<void>;
}

/**
 * Real Slack-backed implementation of {@link SlackInboxApi}. Tests inject a
 * fake when exercising {@link autoDiscoverInboxIdentities} / {@link notifyInbox}.
 */
export const realSlackInboxApi: SlackInboxApi = {
  async usersList(botToken) {
    const client = slackClient(botToken);
    const out: Array<{ id: string; email: string | null }> = [];
    let cursor: string | undefined;
    do {
      const res = await withRetry(() =>
        client.users.list({ limit: 200, cursor }),
      );
      const members = (
        res as {
          members?: Array<{ id?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string } }>;
        }
      ).members ?? [];
      for (const m of members) {
        if (!m.id || m.deleted || m.is_bot) continue;
        out.push({ id: m.id, email: m.profile?.email ?? null });
      }
      cursor = (
        res as { response_metadata?: { next_cursor?: string } }
      ).response_metadata?.next_cursor;
    } while (cursor && cursor.length > 0);
    return out;
  },
  async conversationsOpen(botToken, userId) {
    const client = slackClient(botToken);
    const res = await withRetry(() => client.conversations.open({ users: userId }));
    const channelId = (res as { channel?: { id?: string } }).channel?.id;
    if (!channelId) throw new Error("slack conversations.open: no channel id");
    return { channelId };
  },
  async postMessage(botToken, args) {
    const client = slackClient(botToken);
    const res = await withRetry(() =>
      client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        blocks: (args.blocks as never) ?? undefined,
      }),
    );
    const ts = (res as { ts?: string }).ts;
    if (!ts) throw new Error("slack chat.postMessage: no ts");
    return { ts };
  },
  async updateMessage(botToken, args) {
    const client = slackClient(botToken);
    await withRetry(() =>
      client.chat.update({
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        blocks: (args.blocks as never) ?? undefined,
      }),
    );
  },
};

// ---- Auto-discovery -------------------------------------------------------

export interface AutoDiscoverArgs {
  companyId: string;
  botToken: string;
  api?: SlackInboxApi;
}

export interface AutoDiscoverResult {
  inserted: number;
  matched: number;
}

/**
 * Fetch the Slack workspace's user list (bot token), match each user's email
 * against Paperclip's `authUsers.email`, and insert a `messaging_identities`
 * row for each match that doesn't already have one. Idempotent.
 */
export async function autoDiscoverInboxIdentities(
  db: Db,
  args: AutoDiscoverArgs,
): Promise<AutoDiscoverResult> {
  const api = args.api ?? realSlackInboxApi;
  const slackUsers = await api.usersList(args.botToken);
  const emails = slackUsers
    .map((u) => u.email?.toLowerCase())
    .filter((e): e is string => typeof e === "string" && e.length > 0);
  if (emails.length === 0) return { inserted: 0, matched: 0 };

  const users = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers);
  const userByEmail = new Map(
    users.map((u) => [u.email.toLowerCase(), u.id] as const),
  );

  let inserted = 0;
  let matched = 0;
  for (const slackUser of slackUsers) {
    const email = slackUser.email?.toLowerCase();
    if (!email) continue;
    const userId = userByEmail.get(email);
    if (!userId) continue;
    matched += 1;

    const [existing] = await db
      .select({ id: messagingIdentities.id })
      .from(messagingIdentities)
      .where(
        and(
          eq(messagingIdentities.backend, BACKEND),
          eq(messagingIdentities.companyId, args.companyId),
          eq(messagingIdentities.userId, userId),
        ),
      )
      .limit(1);
    if (existing) continue;

    await db.insert(messagingIdentities).values({
      companyId: args.companyId,
      userId,
      backend: BACKEND,
      externalUserRef: slackUser.id,
      state: "active",
      authBlobSecretId: null,
    });
    inserted += 1;
  }
  return { inserted, matched };
}

// ---- Block helpers --------------------------------------------------------

function buildDeepLink(args: {
  teamId: string;
  channelId: string;
  threadTs?: string;
}): string {
  const base = `slack://channel?team=${args.teamId}&id=${args.channelId}`;
  return args.threadTs ? `${base}&thread_ts=${args.threadTs}` : base;
}

interface InboxPostContent {
  text: string;
  blocks: unknown[];
}

function summarizeEvent(event: InboxEvent): {
  header: string;
  body: string;
} {
  switch (event.kind) {
    case "assignment": {
      const from = event.fromAgentName ?? event.fromUserName ?? "someone";
      const prio = event.priority ? ` (${event.priority})` : "";
      return {
        header: "New assignment",
        body: `${from} assigned you an issue${prio}.`,
      };
    }
    case "mention": {
      return {
        header: "You were mentioned",
        body: `${event.fromDisplayName} mentioned you in a thread.`,
      };
    }
    case "approval_requested": {
      return {
        header: "Approval requested",
        body: event.summary,
      };
    }
    case "status_change": {
      return {
        header: "Status change",
        body: `Status moved to *${event.newStatus}*.`,
      };
    }
  }
}

function buildPost(args: {
  event: InboxEvent;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  rollupCount?: number;
  deepLinkUrl?: string;
}): InboxPostContent {
  const { header, body } = summarizeEvent(args.event);
  const titleLine = args.issueIdentifier
    ? `*[${args.issueIdentifier}] ${args.issueTitle ?? ""}*`
    : "";
  const rollup =
    args.rollupCount && args.rollupCount > 1
      ? `\n_${args.rollupCount} updates in the last 2 minutes._`
      : "";
  const textFallback = `${header}: ${body}${titleLine ? ` — ${titleLine}` : ""}`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: header } },
  ];
  const sectionText = [titleLine, body, rollup].filter((s) => s).join("\n");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: sectionText || body },
  });
  if (args.deepLinkUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in Slack" },
          url: args.deepLinkUrl,
        },
      ],
    });
  }
  return { text: textFallback, blocks };
}

// ---- notifyInbox ----------------------------------------------------------

export interface NotifyInboxArgs {
  userId: string;
  companyId: string;
  event: InboxEvent;
  api?: SlackInboxApi;
  nowMs?: () => number;
  /**
   * Test injection point for the bot token + workspace team id. When omitted,
   * both are resolved from the company's messaging_workspace_install row + the
   * Slack token store. Tests skip the install row and inject directly.
   */
  workspace?: { botToken: string; teamId: string };
}

export interface NotifyInboxResult {
  posted: boolean;
  edited: boolean;
  channelId: string | null;
  reason?: string;
}

interface InboxChannelMeta extends Record<string, unknown> {
  lastPostedExternalRef?: string;
  lastPostedAt?: string;
  lastIssueId?: string;
  rollupCount?: number;
}

function prefsFor(
  rawPrefs: Record<string, unknown> | null | undefined,
): Required<InboxPreferences> {
  return { ...DEFAULT_PREFS, ...(rawPrefs ?? {}) } as Required<InboxPreferences>;
}

function issueIdFromEvent(event: InboxEvent): string | null {
  if (event.kind === "approval_requested") return event.issueId ?? null;
  return event.issueId;
}

/**
 * Deliver a single inbox event to the DM for a given user. Opens the DM on
 * first call, respects subscription preferences, and rolls up repeat events
 * on the same issue within a 2-minute window.
 */
export async function notifyInbox(
  db: Db,
  args: NotifyInboxArgs,
): Promise<NotifyInboxResult> {
  const api = args.api ?? realSlackInboxApi;
  const now = args.nowMs?.() ?? Date.now();

  // Identity: DM target must have a messaging_identities row. This is how we
  // know their Slack user id (externalUserRef) and respect prefs.
  const [identity] = await db
    .select()
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.backend, BACKEND),
        eq(messagingIdentities.companyId, args.companyId),
        eq(messagingIdentities.userId, args.userId),
      ),
    )
    .limit(1);
  if (!identity) {
    return { posted: false, edited: false, channelId: null, reason: "no_identity" };
  }
  if (identity.state !== "active") {
    return { posted: false, edited: false, channelId: null, reason: "identity_not_active" };
  }

  const prefs = prefsFor(identity.inboxPreferences);
  if (!prefs[args.event.kind]) {
    return { posted: false, edited: false, channelId: null, reason: "pref_disabled" };
  }

  // Resolve bot token + workspace team id. Tests inject directly; prod reads
  // from the company's workspace install + the Slack token store.
  let botToken: string;
  let teamId: string;
  if (args.workspace) {
    botToken = args.workspace.botToken;
    teamId = args.workspace.teamId;
  } else {
    const [install] = await db
      .select()
      .from(messagingWorkspaceInstall)
      .where(
        and(
          eq(messagingWorkspaceInstall.backend, BACKEND),
          eq(messagingWorkspaceInstall.companyId, args.companyId),
        ),
      )
      .limit(1);
    if (!install) {
      return { posted: false, edited: false, channelId: null, reason: "no_install" };
    }
    teamId = install.externalWorkspaceRef;
    const { getBotTokenForCompany } = await import("./adapters/slack/token-store.js");
    botToken = await getBotTokenForCompany(db, args.companyId);
  }

  // Get-or-open DM channel.
  let [channel] = await db
    .select()
    .from(messagingChannels)
    .where(
      and(
        eq(messagingChannels.backend, BACKEND),
        eq(messagingChannels.companyId, args.companyId),
        eq(messagingChannels.purpose, "inbox"),
        eq(messagingChannels.userId, args.userId),
      ),
    )
    .limit(1);

  if (!channel) {
    const opened = await api.conversationsOpen(botToken, identity.externalUserRef);
    const [inserted] = await db
      .insert(messagingChannels)
      .values({
        companyId: args.companyId,
        backend: BACKEND,
        purpose: "inbox",
        userId: args.userId,
        externalChannelRef: opened.channelId,
        externalChannelName: null,
        state: "active",
        metadata: null,
      })
      .returning();
    channel = inserted!;
  }

  // Enrich content with issue identifier/title for human-friendly cards.
  const issueId = issueIdFromEvent(args.event);
  let issueIdentifier: string | null = null;
  let issueTitle: string | null = null;
  if (issueId) {
    const [iss] = await db
      .select({
        identifier: issuesTable.identifier,
        title: issuesTable.title,
      })
      .from(issuesTable)
      .where(eq(issuesTable.id, issueId))
      .limit(1);
    if (iss) {
      issueIdentifier = iss.identifier ?? null;
      issueTitle = iss.title ?? null;
    }
  }

  const meta = (channel.metadata as InboxChannelMeta | null) ?? {};
  const withinWindow =
    !!meta.lastPostedAt &&
    !!meta.lastPostedExternalRef &&
    now - new Date(meta.lastPostedAt).getTime() < DEDUP_WINDOW_MS;
  const sameIssue = !!issueId && meta.lastIssueId === issueId;

  const deepLinkUrl = buildDeepLink({
    teamId,
    channelId: channel.externalChannelRef,
  });

  if (withinWindow && sameIssue) {
    const rollupCount = (meta.rollupCount ?? 1) + 1;
    const post = buildPost({
      event: args.event,
      issueIdentifier,
      issueTitle,
      rollupCount,
      deepLinkUrl,
    });
    await api.updateMessage(botToken, {
      channel: channel.externalChannelRef,
      ts: meta.lastPostedExternalRef!,
      text: post.text,
      blocks: post.blocks,
    });
    const nextMeta: InboxChannelMeta = {
      ...meta,
      rollupCount,
      lastPostedAt: new Date(now).toISOString(),
    };
    await db
      .update(messagingChannels)
      .set({ metadata: nextMeta, updatedAt: new Date(now) })
      .where(eq(messagingChannels.id, channel.id));
    return { posted: false, edited: true, channelId: channel.id };
  }

  const post = buildPost({
    event: args.event,
    issueIdentifier,
    issueTitle,
    deepLinkUrl,
  });
  const posted = await api.postMessage(botToken, {
    channel: channel.externalChannelRef,
    text: post.text,
    blocks: post.blocks,
  });
  const nextMeta: InboxChannelMeta = {
    lastPostedExternalRef: posted.ts,
    lastPostedAt: new Date(now).toISOString(),
    lastIssueId: issueId ?? undefined,
    rollupCount: 1,
  };
  await db
    .update(messagingChannels)
    .set({ metadata: nextMeta, updatedAt: new Date(now) })
    .where(eq(messagingChannels.id, channel.id));
  return { posted: true, edited: false, channelId: channel.id };
}

// ---- Dispatch helpers for callers ----------------------------------------
//
// Every helper is fire-and-forget. Callers wrap invocations in try/catch so
// inbox failures never fail the underlying business operation (issue update,
// approval creation, mention, …).

async function safeDispatch(fn: () => Promise<unknown>, context: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`inbox dispatch failed [${context}]`, err);
  }
}

export async function dispatchInboxForAssignment(
  db: Db,
  args: {
    companyId: string;
    assigneeUserId: string;
    issueId: string;
    fromAgentName?: string | null;
    fromUserName?: string | null;
    priority?: string | null;
    api?: SlackInboxApi;
  },
): Promise<void> {
  await safeDispatch(
    () =>
      notifyInbox(db, {
        companyId: args.companyId,
        userId: args.assigneeUserId,
        event: {
          kind: "assignment",
          issueId: args.issueId,
          fromAgentName: args.fromAgentName,
          fromUserName: args.fromUserName,
          priority: args.priority,
        },
        api: args.api,
      }),
    "assignment",
  );
}

export async function dispatchInboxForMention(
  db: Db,
  args: {
    companyId: string;
    mentionedUserId: string;
    issueId: string;
    fromDisplayName: string;
    commentRefId: string;
    api?: SlackInboxApi;
  },
): Promise<void> {
  await safeDispatch(
    () =>
      notifyInbox(db, {
        companyId: args.companyId,
        userId: args.mentionedUserId,
        event: {
          kind: "mention",
          issueId: args.issueId,
          fromDisplayName: args.fromDisplayName,
          commentRefId: args.commentRefId,
        },
        api: args.api,
      }),
    "mention",
  );
}

export async function dispatchInboxForApprovalRequest(
  db: Db,
  args: {
    companyId: string;
    approverUserId: string;
    approvalId: string;
    summary: string;
    issueId?: string | null;
    api?: SlackInboxApi;
  },
): Promise<void> {
  await safeDispatch(
    () =>
      notifyInbox(db, {
        companyId: args.companyId,
        userId: args.approverUserId,
        event: {
          kind: "approval_requested",
          approvalId: args.approvalId,
          issueId: args.issueId ?? null,
          summary: args.summary,
        },
        api: args.api,
      }),
    "approval_requested",
  );
}

export async function dispatchInboxForStatusChange(
  db: Db,
  args: {
    companyId: string;
    ownerUserId: string;
    issueId: string;
    newStatus: string;
    api?: SlackInboxApi;
  },
): Promise<void> {
  await safeDispatch(
    () =>
      notifyInbox(db, {
        companyId: args.companyId,
        userId: args.ownerUserId,
        event: {
          kind: "status_change",
          issueId: args.issueId,
          newStatus: args.newStatus,
        },
        api: args.api,
      }),
    "status_change",
  );
}

// ---- Preference helpers (used by routes) ---------------------------------

export async function getInboxPreferences(
  db: Db,
  args: { companyId: string; userId: string },
): Promise<Required<InboxPreferences>> {
  const [identity] = await db
    .select({ inboxPreferences: messagingIdentities.inboxPreferences })
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.backend, BACKEND),
        eq(messagingIdentities.companyId, args.companyId),
        eq(messagingIdentities.userId, args.userId),
      ),
    )
    .limit(1);
  return prefsFor(identity?.inboxPreferences);
}

export async function setInboxPreferences(
  db: Db,
  args: {
    companyId: string;
    userId: string;
    prefs: Record<string, boolean>;
  },
): Promise<Required<InboxPreferences>> {
  const [identity] = await db
    .select()
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.backend, BACKEND),
        eq(messagingIdentities.companyId, args.companyId),
        eq(messagingIdentities.userId, args.userId),
      ),
    )
    .limit(1);
  if (!identity) {
    throw new Error(
      `setInboxPreferences: no identity for user ${args.userId} in company ${args.companyId}`,
    );
  }
  const existing = (identity.inboxPreferences ?? {}) as Record<string, unknown>;
  const merged = { ...existing, ...args.prefs };
  await db
    .update(messagingIdentities)
    .set({ inboxPreferences: merged, updatedAt: new Date() })
    .where(eq(messagingIdentities.id, identity.id));
  return prefsFor(merged);
}
