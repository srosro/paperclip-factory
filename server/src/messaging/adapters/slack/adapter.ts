import type {
  MessagingAdapter,
  CapabilityFlags,
  CreateChannelArgs,
  CreateThreadArgs,
  PostMessageArgs,
  AuthorIdentity,
  ExternalRef,
  Message,
  MessagingEvent,
  ProvisionAgentIdentityArgs,
  ProvisionResult,
} from "../../types.js";
import { slackClient, withRetry } from "./client.js";

export interface SlackDeps {
  /**
   * Resolve the workspace-level bot token (one per company install).
   */
  getBotToken(companyId: string): Promise<string>;
  /**
   * Resolve a per-agent user token by secret id (populated via OAuth in
   * Part 10). Each agent posts as itself using its user token.
   */
  getUserToken(companyId: string, secretId: string): Promise<string>;
  /**
   * Company whose workspace this adapter instance should target. Supplied by
   * the router when it requires adapter calls scoped to a specific install.
   */
  companyId?: string;
  nowMs?: () => number;
}

const capabilities: CapabilityFlags = {
  supportsThreads: true,
  supportsEditing: true,
  supportsReactions: true,
  supportsButtons: true,
  supportsFileUpload: true,
  supportsThreadLock: false,
  requiresUserAuthPerIdentity: true,
};

function requireCompanyId(deps: SlackDeps): string {
  if (!deps.companyId) {
    throw new Error(
      "Slack adapter requires companyId in deps for workspace-scoped operations",
    );
  }
  return deps.companyId;
}

function normalizeSlackChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "channel";
}

function tsToDate(ts: string): Date {
  const n = Number(ts);
  if (!Number.isFinite(n)) return new Date();
  return new Date(Math.floor(n * 1000));
}

interface SlackMessagePayload {
  type?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  blocks?: unknown;
  edited?: { ts?: string };
  reactions?: Array<{ name?: string; users?: string[] }>;
}

function payloadToMessage(payload: SlackMessagePayload, threadRef: string): Message | null {
  if (!payload.ts) return null;
  const reactions: Record<string, string[]> | undefined = payload.reactions
    ? Object.fromEntries(
        payload.reactions
          .filter((r) => typeof r.name === "string")
          .map((r) => [r.name as string, (r.users ?? []).slice()]),
      )
    : undefined;
  return {
    refId: "",
    externalMessageRef: payload.ts,
    threadRef,
    body: payload.text ?? "",
    blocks: payload.blocks,
    authorExternalRef: payload.user ?? payload.bot_id ?? "",
    createdAt: tsToDate(payload.ts),
    editedAt: payload.edited?.ts ? tsToDate(payload.edited.ts) : undefined,
    reactions,
  };
}

export function createSlackAdapter(deps: SlackDeps): MessagingAdapter {
  async function botClient() {
    return slackClient(await deps.getBotToken(requireCompanyId(deps)));
  }

  async function userClient(secretId: string) {
    return slackClient(await deps.getUserToken(requireCompanyId(deps), secretId));
  }

  async function clientForIdentity(identity: AuthorIdentity) {
    if (identity.credential.kind === "user_token") {
      return userClient(identity.credential.secretId);
    }
    if (identity.credential.kind === "bot_token") {
      return botClient();
    }
    throw new Error("slack adapter: identity credential must be user_token or bot_token");
  }

  return {
    backendKey: "slack",
    capabilities,

    async createChannel(args: CreateChannelArgs) {
      const client = await botClient();
      const res = await withRetry(() =>
        client.conversations.create({
          name: normalizeSlackChannelName(args.name),
          is_private: args.private ?? false,
        }),
      );
      const channel = (res as { channel?: { id?: string; name?: string } }).channel;
      if (!channel?.id) throw new Error("slack createChannel: no channel id returned");
      return { externalRef: channel.id, name: channel.name ?? args.name };
    },

    async archiveChannel(channelRef: ExternalRef) {
      const client = await botClient();
      await withRetry(() => client.conversations.archive({ channel: channelRef }));
    },

    async addChannelMember(channelRef: ExternalRef, identityRef: ExternalRef) {
      const client = await botClient();
      try {
        await withRetry(() =>
          client.conversations.invite({ channel: channelRef, users: identityRef }),
        );
      } catch (err) {
        // already_in_channel is a benign no-op for idempotent callers.
        const code = (err as { data?: { error?: string } })?.data?.error;
        if (code === "already_in_channel") return;
        throw err;
      }
    },

    async removeChannelMember(channelRef: ExternalRef, identityRef: ExternalRef) {
      const client = await botClient();
      await withRetry(() =>
        client.conversations.kick({ channel: channelRef, user: identityRef }),
      );
    },

    async createThread(args: CreateThreadArgs): Promise<{
      threadRef: ExternalRef;
      parentMessageRef: ExternalRef;
    }> {
      const client = await botClient();
      const res = await withRetry(() =>
        client.chat.postMessage({
          channel: args.channelRef,
          text: args.fallbackText,
          blocks: (args.parentBlocks as never) ?? undefined,
        }),
      );
      const ts = (res as { ts?: string }).ts;
      if (!ts) throw new Error("slack createThread: no ts returned");
      return { threadRef: ts, parentMessageRef: ts };
    },

    async lockThread(_threadRef: ExternalRef) {
      // Slack has no native thread lock. The router tracks locked state in
      // messaging_threads.state and the events processor drops inbound
      // messages on locked threads. Nothing to do at the adapter layer.
    },

    async postMessage(args: PostMessageArgs): Promise<{
      messageRef: ExternalRef;
      createdAt: Date;
    }> {
      const client = await clientForIdentity(args.authorIdentity);
      const res = await withRetry(() =>
        client.chat.postMessage({
          channel: args.channelRef,
          thread_ts: args.threadRef,
          text: args.body,
          blocks: (args.blocks as never) ?? undefined,
        }),
      );
      const ts = (res as { ts?: string }).ts;
      if (!ts) throw new Error("slack postMessage: no ts returned");
      return { messageRef: ts, createdAt: tsToDate(ts) };
    },

    async editMessage(
      channelRef: ExternalRef,
      messageRef: ExternalRef,
      body: string,
      blocks?: unknown,
    ) {
      const client = await botClient();
      await withRetry(() =>
        client.chat.update({
          channel: channelRef,
          ts: messageRef,
          text: body,
          blocks: (blocks as never) ?? undefined,
        }),
      );
    },

    async deleteMessage(
      channelRef: ExternalRef,
      messageRef: ExternalRef,
      by: AuthorIdentity,
    ) {
      const client = await clientForIdentity(by);
      await withRetry(() =>
        client.chat.delete({ channel: channelRef, ts: messageRef }),
      );
    },

    async getThreadMessages(
      channelRef: ExternalRef,
      threadRef: ExternalRef,
    ): Promise<Message[]> {
      const client = await botClient();
      const messages: Message[] = [];
      let cursor: string | undefined;
      do {
        const res = await withRetry(() =>
          client.conversations.replies({
            channel: channelRef,
            ts: threadRef,
            cursor,
            limit: 200,
          }),
        );
        const payloads = (res as { messages?: SlackMessagePayload[] }).messages ?? [];
        for (const p of payloads) {
          const m = payloadToMessage(p, threadRef);
          if (m) messages.push(m);
        }
        cursor = (res as { response_metadata?: { next_cursor?: string } }).response_metadata
          ?.next_cursor;
      } while (cursor && cursor.length > 0);
      return messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async getMessage(
      channelRef: ExternalRef,
      messageRef: ExternalRef,
    ): Promise<Message | null> {
      const client = await botClient();
      const res = await withRetry(() =>
        client.conversations.history({
          channel: channelRef,
          latest: messageRef,
          oldest: messageRef,
          inclusive: true,
          limit: 1,
        }),
      );
      const payloads = (res as { messages?: SlackMessagePayload[] }).messages ?? [];
      const p = payloads[0];
      if (!p) return null;
      return payloadToMessage(p, p.thread_ts ?? messageRef);
    },

    async provisionAgentIdentity(
      _args: ProvisionAgentIdentityArgs,
    ): Promise<ProvisionResult> {
      // Per-agent identity creation requires OAuth redirect. The HTTP flow
      // lives in Part 10 (routes/messaging-slack-oauth.ts). At the adapter
      // layer we simply report that user action is needed.
      return {
        kind: "needs_user_action",
        redirectUrl: "",
        stateToken: "",
      };
    },

    async resolveExternalUser(externalRef: ExternalRef) {
      try {
        const client = await botClient();
        const res = await withRetry(() =>
          client.users.info({ user: externalRef }),
        );
        const user = (res as {
          user?: { profile?: { real_name?: string; email?: string }; name?: string };
        }).user;
        if (!user) return null;
        return {
          displayName: user.profile?.real_name ?? user.name,
          email: user.profile?.email,
        };
      } catch {
        return null;
      }
    },

    normalizeEvent(raw: unknown): MessagingEvent | null {
      return normalizeSlackEvent(raw);
    },
  };
}

/**
 * Translate a raw Slack Events API envelope to a canonical MessagingEvent.
 * Returns null for events that aren't comms-relevant.
 */
export function normalizeSlackEvent(raw: unknown): MessagingEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const envelope = raw as {
    event_id?: string;
    event?: Record<string, unknown>;
    type?: string;
  };
  const eventId = envelope.event_id;
  const evt = envelope.event;
  if (!eventId || !evt || typeof evt !== "object") return null;

  const eType = (evt as { type?: string }).type;
  switch (eType) {
    case "message": {
      const subtype = (evt as { subtype?: string }).subtype;
      if (subtype === "message_changed") {
        const inner = (evt as { message?: SlackMessagePayload; channel?: string }).message;
        const channel = (evt as { channel?: string }).channel;
        if (!inner?.ts || !channel) return null;
        return {
          kind: "message_changed",
          externalEventId: eventId,
          messageRef: inner.ts,
          channelRef: channel,
          bodyRaw: inner.text ?? "",
          editedAt: inner.edited?.ts ? tsToDate(inner.edited.ts) : new Date(),
        };
      }
      if (subtype === "message_deleted") {
        const deletedTs = (evt as { deleted_ts?: string; previous_message?: SlackMessagePayload })
          .deleted_ts;
        const channel = (evt as { channel?: string }).channel;
        if (!deletedTs || !channel) return null;
        const eventTs = (evt as { event_ts?: string }).event_ts;
        return {
          kind: "message_deleted",
          externalEventId: eventId,
          messageRef: deletedTs,
          channelRef: channel,
          deletedAt: eventTs ? tsToDate(eventTs) : new Date(),
        };
      }
      // Ignore bot-only automation subtypes we don't care about.
      if (subtype && subtype !== "thread_broadcast") return null;

      const payload = evt as SlackMessagePayload & { channel?: string };
      if (!payload.ts || !payload.channel || !payload.user) return null;
      return {
        kind: "message",
        externalEventId: eventId,
        channelRef: payload.channel,
        threadRef: payload.thread_ts,
        messageRef: payload.ts,
        authorExternalRef: payload.user,
        bodyRaw: payload.text ?? "",
        createdAt: tsToDate(payload.ts),
      };
    }
    case "reaction_added":
    case "reaction_removed": {
      const item = (evt as { item?: { ts?: string; channel?: string } }).item;
      const user = (evt as { user?: string }).user;
      const reaction = (evt as { reaction?: string }).reaction;
      const eventTs = (evt as { event_ts?: string }).event_ts;
      if (!item?.ts || !item.channel || !user || !reaction) return null;
      return {
        kind: eType,
        externalEventId: eventId,
        messageRef: item.ts,
        channelRef: item.channel,
        reactorExternalRef: user,
        emoji: reaction,
        at: eventTs ? tsToDate(eventTs) : new Date(),
      };
    }
    default:
      return null;
  }
}
