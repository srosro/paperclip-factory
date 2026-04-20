import { and, eq, sql } from "drizzle-orm";
import {
  issues as issuesTable,
  issueCommentRefs,
  messagingIdentities,
  messagingEventsInbox,
} from "@paperclipai/db";
import type { BackendKey, MessagingEvent } from "./types.js";
import type { Db } from "./router.js";

export interface EventsDeps {
  db: Db;
  backend: BackendKey;
  workspaceInstallId?: string | null;
  onMessageCreated?: (args: {
    refId: string;
    companyId: string;
    issueId: string;
    authorAgentId: string | null;
    authorUserId: string | null;
    authorExternalRef: string;
    mentionedAgentIds: string[];
  }) => Promise<void>;
  resolveMentions?: (rawBody: string) => Promise<{
    agentIds: string[];
  }>;
  /**
   * Called after an event is accepted. Backends (Linear) plug in cache-sync
   * handlers here — they apply the event to Paperclip's local issues /
   * issue_comment_refs cache.
   */
  syncFromEvent?: (event: MessagingEvent) => Promise<void>;
  /**
   * Predicate for self-origination filtering. When true for a given event,
   * the handler skips all side-effect + cache-sync work. Used by Linear to
   * suppress webhook echoes of Paperclip-originated writes.
   */
  isSelfOriginated?: (event: MessagingEvent) => boolean;
}

export interface EventsProcessor {
  handle(event: MessagingEvent): Promise<void>;
}

export function createEventsProcessor(deps: EventsDeps): EventsProcessor {
  return {
    async handle(event) {
      const inserted = await deps.db
        .insert(messagingEventsInbox)
        .values({ backend: deps.backend, externalEventId: event.externalEventId })
        .onConflictDoNothing({
          target: [
            messagingEventsInbox.backend,
            messagingEventsInbox.externalEventId,
          ],
        })
        .returning();
      if (inserted.length === 0) return;

      if (deps.isSelfOriginated?.(event)) {
        await deps.db
          .update(messagingEventsInbox)
          .set({ processedAt: new Date() })
          .where(
            and(
              eq(messagingEventsInbox.backend, deps.backend),
              eq(messagingEventsInbox.externalEventId, event.externalEventId),
            ),
          );
        return;
      }

      switch (event.kind) {
        case "comment_created":
          await handleCommentCreated(deps, event);
          break;
        case "comment_updated":
          await handleCommentUpdated(deps, event);
          break;
        case "comment_deleted":
          await handleCommentDeleted(deps, event);
          break;
        case "reaction_added":
        case "reaction_removed":
          await handleReaction(deps, event);
          break;
        case "issue_created":
        case "issue_updated":
        case "issue_assignee_changed":
        case "issue_removed":
        case "labels_changed":
        case "attachment_changed":
        case "project_changed":
          // Handled via deps.syncFromEvent below.
          break;
      }

      if (deps.syncFromEvent) {
        try {
          await deps.syncFromEvent(event);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("events: syncFromEvent failed", err);
        }
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

async function handleCommentCreated(
  deps: EventsDeps,
  event: Extract<MessagingEvent, { kind: "comment_created" }>,
) {
  const [issue] = await deps.db
    .select()
    .from(issuesTable)
    .where(eq(issuesTable.linearIssueId, event.externalIssueRef))
    .limit(1);
  if (!issue) return;

  const author = await loadIdentityByExternal(deps, event.authorExternalRef);

  const [row] = await deps.db
    .insert(issueCommentRefs)
    .values({
      issueId: issue.id,
      backend: deps.backend,
      externalMessageRef: event.externalCommentRef,
      authorAgentId: author?.agentId ?? null,
      authorUserId: author?.userId ?? null,
      firstSeenAt: event.createdAt,
    })
    .onConflictDoNothing({
      target: [issueCommentRefs.issueId, issueCommentRefs.externalMessageRef],
    })
    .returning();
  if (!row) return;
  if (row.suppressedForWake) return;
  if (!deps.onMessageCreated) return;

  const resolved = deps.resolveMentions
    ? await deps.resolveMentions(event.bodyRaw)
    : { agentIds: [] };

  await deps.onMessageCreated({
    refId: row.id,
    companyId: issue.companyId,
    issueId: issue.id,
    authorAgentId: row.authorAgentId,
    authorUserId: row.authorUserId,
    authorExternalRef: event.authorExternalRef,
    mentionedAgentIds: resolved.agentIds,
  });
}

async function handleCommentUpdated(
  deps: EventsDeps,
  event: Extract<MessagingEvent, { kind: "comment_updated" }>,
) {
  await deps.db
    .update(issueCommentRefs)
    .set({
      editedAt: event.editedAt,
      editCount: sql`${issueCommentRefs.editCount} + 1`,
    })
    .where(
      and(
        eq(issueCommentRefs.backend, deps.backend),
        eq(issueCommentRefs.externalMessageRef, event.externalCommentRef),
      ),
    );
}

async function handleCommentDeleted(
  deps: EventsDeps,
  event: Extract<MessagingEvent, { kind: "comment_deleted" }>,
) {
  await deps.db
    .update(issueCommentRefs)
    .set({ deletedAt: event.deletedAt })
    .where(
      and(
        eq(issueCommentRefs.backend, deps.backend),
        eq(issueCommentRefs.externalMessageRef, event.externalCommentRef),
      ),
    );
}

async function handleReaction(
  deps: EventsDeps,
  event: Extract<MessagingEvent, { kind: "reaction_added" | "reaction_removed" }>,
) {
  const [row] = await deps.db
    .select()
    .from(issueCommentRefs)
    .where(
      and(
        eq(issueCommentRefs.backend, deps.backend),
        eq(issueCommentRefs.externalMessageRef, event.externalCommentRef),
      ),
    )
    .limit(1);
  if (!row) return;
  const current: Record<string, string[]> =
    (row.reactions as Record<string, string[]> | null) ?? {};
  const reactors = new Set(current[event.emoji] ?? []);
  if (event.kind === "reaction_added") reactors.add(event.reactorExternalRef);
  else reactors.delete(event.reactorExternalRef);
  if (reactors.size > 0) current[event.emoji] = [...reactors];
  else delete current[event.emoji];
  await deps.db
    .update(issueCommentRefs)
    .set({ reactions: current })
    .where(eq(issueCommentRefs.id, row.id));
}

async function loadIdentityByExternal(deps: EventsDeps, externalRef: string) {
  const whereClauses = deps.workspaceInstallId
    ? and(
        eq(messagingIdentities.workspaceInstallId, deps.workspaceInstallId),
        eq(messagingIdentities.externalUserRef, externalRef),
      )
    : and(
        eq(messagingIdentities.backend, deps.backend),
        eq(messagingIdentities.externalUserRef, externalRef),
      );
  const rows = await deps.db
    .select()
    .from(messagingIdentities)
    .where(whereClauses)
    .limit(1);
  return rows[0];
}
