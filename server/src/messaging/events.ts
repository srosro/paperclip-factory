import { eq, and, sql } from "drizzle-orm";
import {
  messagingChannels,
  messagingThreads,
  messagingIdentities,
  messagingMessageRefs,
  messagingEventsInbox,
} from "@paperclipai/db";
import type { BackendKey, IncomingFileRef, MessagingEvent } from "./types.js";
import type { Db } from "./router.js";

export interface IngestInboundFilesArgs {
  companyId: string;
  issueId: string;
  refId: string;
  authorExternalRef: string;
  files: IncomingFileRef[];
}

export interface EventsDeps {
  db: Db;
  backend: BackendKey;
  /**
   * Fired after a new-message event is persisted as a ref row, only when
   * the ref's suppressedForWake flag is false.
   */
  onMessageCreated?: (args: {
    refId: string;
    companyId: string;
    issueId: string;
    authorAgentId: string | null;
    authorUserId: string | null;
    authorExternalRef: string;
    mentionedAgentIds: string[];
    mentionedUserIds: string[];
  }) => Promise<void>;
  /**
   * Optional mention resolver — adapters that can pre-parse mentions from
   * raw body should expose this. Events module passes in the raw body and
   * expects lists of Paperclip agent ids + user ids (for inbox dispatch).
   */
  resolveMentions?: (
    rawBody: string,
  ) => Promise<{ agentIds: string[]; userIds: string[] }>;
  /**
   * Optional: backend-specific file ingest. Called for each inbound message
   * that carries files. The implementation must download bytes (using a user
   * token when needed), register assets, and insert issue_attachments rows.
   * Errors must be logged and swallowed — partial ingest is preferable to
   * dropping the whole event.
   */
  ingestInboundFiles?: (args: IngestInboundFilesArgs) => Promise<void>;
}

export interface EventsProcessor {
  handle(event: MessagingEvent): Promise<void>;
}

export function createEventsProcessor(deps: EventsDeps): EventsProcessor {
  return {
    async handle(event) {
      // Idempotency: insert event id; if duplicate, skip.
      const inserted = await deps.db
        .insert(messagingEventsInbox)
        .values({
          backend: deps.backend,
          externalEventId: event.externalEventId,
        })
        .onConflictDoNothing({
          target: [
            messagingEventsInbox.backend,
            messagingEventsInbox.externalEventId,
          ],
        })
        .returning();
      if (inserted.length === 0) return;

      switch (event.kind) {
        case "message":
          await handleNewMessage(deps, event);
          break;
        case "message_changed":
          await handleEdit(deps, event);
          break;
        case "message_deleted":
          await handleDelete(deps, event);
          break;
        case "reaction_added":
        case "reaction_removed":
          await handleReaction(deps, event);
          break;
      }

      await deps.db
        .update(messagingEventsInbox)
        .set({ processedAt: new Date() })
        .where(
          and(
            eq(messagingEventsInbox.backend, deps.backend),
            eq(messagingEventsInbox.externalEventId, event.externalEventId),
          ),
        );
    },
  };
}

async function handleNewMessage(
  deps: EventsDeps,
  event: Extract<MessagingEvent, { kind: "message" }>,
) {
  const channel = await loadChannelByExternal(deps, event.channelRef);
  if (!channel) return; // not one of ours

  const threadRef = event.threadRef ?? event.messageRef;
  const thread = await loadThreadByExternal(deps, threadRef);
  if (!thread) return; // either top-level message or a thread we don't track

  if (thread.state === "locked") return; // thread is locked; don't record or wake

  const author = await loadIdentityByExternal(deps, event.authorExternalRef);

  const [row] = await deps.db
    .insert(messagingMessageRefs)
    .values({
      threadId: thread.id,
      backend: deps.backend,
      externalMessageRef: event.messageRef,
      authorAgentId: author?.agentId ?? null,
      authorUserId: author?.userId ?? null,
      firstSeenAt: event.createdAt,
    })
    .onConflictDoNothing({
      target: [
        messagingMessageRefs.backend,
        messagingMessageRefs.externalMessageRef,
      ],
    })
    .returning();
  if (!row) return; // already existed (agent-write path already inserted)

  // Ingest any inbound files (Slack attachments) before wake-up hooks so the
  // wake-up signal observes the full state. Errors must be swallowed so
  // wake-up still fires when file ingest fails.
  if (event.files && event.files.length > 0 && deps.ingestInboundFiles) {
    try {
      await deps.ingestInboundFiles({
        companyId: channel.companyId,
        issueId: thread.issueId,
        refId: row.id,
        authorExternalRef: event.authorExternalRef,
        files: event.files,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `messaging: ingestInboundFiles failed for ref=${row.id}`,
        err,
      );
    }
  }

  if (row.suppressedForWake) return;

  if (!deps.onMessageCreated) return;

  const resolved = deps.resolveMentions
    ? await deps.resolveMentions(event.bodyRaw)
    : { agentIds: [], userIds: [] };

  await deps.onMessageCreated({
    refId: row.id,
    companyId: channel.companyId,
    issueId: thread.issueId,
    authorAgentId: row.authorAgentId,
    authorUserId: row.authorUserId,
    authorExternalRef: event.authorExternalRef,
    mentionedAgentIds: resolved.agentIds,
    mentionedUserIds: resolved.userIds,
  });
}

async function handleEdit(
  deps: EventsDeps,
  event: Extract<MessagingEvent, { kind: "message_changed" }>,
) {
  await deps.db
    .update(messagingMessageRefs)
    .set({
      editedAt: event.editedAt,
      editCount: sql`${messagingMessageRefs.editCount} + 1`,
    })
    .where(
      and(
        eq(messagingMessageRefs.backend, deps.backend),
        eq(messagingMessageRefs.externalMessageRef, event.messageRef),
      ),
    );
}

async function handleDelete(
  deps: EventsDeps,
  event: Extract<MessagingEvent, { kind: "message_deleted" }>,
) {
  await deps.db
    .update(messagingMessageRefs)
    .set({ deletedAt: event.deletedAt })
    .where(
      and(
        eq(messagingMessageRefs.backend, deps.backend),
        eq(messagingMessageRefs.externalMessageRef, event.messageRef),
      ),
    );
}

async function handleReaction(
  deps: EventsDeps,
  event: Extract<MessagingEvent, { kind: "reaction_added" | "reaction_removed" }>,
) {
  const [row] = await deps.db
    .select()
    .from(messagingMessageRefs)
    .where(
      and(
        eq(messagingMessageRefs.backend, deps.backend),
        eq(messagingMessageRefs.externalMessageRef, event.messageRef),
      ),
    )
    .limit(1);
  if (!row) return;

  const current: Record<string, string[]> =
    (row.reactions as Record<string, string[]> | null) ?? {};
  const reactors = new Set(current[event.emoji] ?? []);
  if (event.kind === "reaction_added") {
    reactors.add(event.reactorExternalRef);
  } else {
    reactors.delete(event.reactorExternalRef);
  }
  if (reactors.size > 0) {
    current[event.emoji] = [...reactors];
  } else {
    delete current[event.emoji];
  }
  await deps.db
    .update(messagingMessageRefs)
    .set({ reactions: current })
    .where(eq(messagingMessageRefs.id, row.id));
}

async function loadChannelByExternal(deps: EventsDeps, externalRef: string) {
  const rows = await deps.db
    .select()
    .from(messagingChannels)
    .where(
      and(
        eq(messagingChannels.backend, deps.backend),
        eq(messagingChannels.externalChannelRef, externalRef),
      ),
    )
    .limit(1);
  return rows[0];
}

async function loadThreadByExternal(deps: EventsDeps, externalRef: string) {
  const rows = await deps.db
    .select()
    .from(messagingThreads)
    .where(
      and(
        eq(messagingThreads.backend, deps.backend),
        eq(messagingThreads.externalThreadRef, externalRef),
      ),
    )
    .limit(1);
  return rows[0];
}

async function loadIdentityByExternal(deps: EventsDeps, externalRef: string) {
  const rows = await deps.db
    .select()
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.backend, deps.backend),
        eq(messagingIdentities.externalUserRef, externalRef),
      ),
    )
    .limit(1);
  return rows[0];
}
