import { and, eq, sql } from "drizzle-orm";
import {
  issues as issuesTable,
  issueCommentRefs,
} from "@paperclipai/db";
import type { Db } from "./router.js";
import { heartbeatService } from "../services/heartbeat.js";

export interface MessageCreatedSideEffects {
  refId: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorExternalRef: string;
  mentionedAgentIds: string[];
}

export interface SideEffectDeps {
  db: Db;
}

/**
 * Run the one and only side-effect pipeline for a new message, regardless of
 * origin (inbound webhook, outbound Paperclip post, or fake-adapter echo).
 * Responsibilities:
 *
 *  - respect the ref's suppressedForWake flag
 *  - wake the assignee agent (issue_commented) unless the comment is a
 *    self-comment from the assignee
 *  - wake each @mentioned agent (issue_comment_mentioned) except the author
 *
 * Idempotency: callers must ensure this is invoked at most once per ref id.
 * Today that's enforced by (a) events.ts inserting with onConflictDoNothing
 * so an echoed outbound post does not re-enter this path, and (b) outbound
 * routes calling this once after addComment succeeds.
 */
export async function handleMessageCreatedSideEffects(
  deps: SideEffectDeps,
  args: MessageCreatedSideEffects,
): Promise<void> {
  // Re-check suppressedForWake in case the ref was flipped between creation
  // and dispatch (queued-comment cancel flow).
  const [ref] = await deps.db
    .select({ suppressedForWake: issueCommentRefs.suppressedForWake })
    .from(issueCommentRefs)
    .where(eq(issueCommentRefs.id, args.refId))
    .limit(1);
  if (!ref || ref.suppressedForWake) return;

  const [issue] = await deps.db
    .select({
      id: issuesTable.id,
      companyId: issuesTable.companyId,
      assigneeAgentId: issuesTable.assigneeAgentId,
    })
    .from(issuesTable)
    .where(eq(issuesTable.id, args.issueId))
    .limit(1);
  if (!issue) return;

  const heartbeat = heartbeatService(deps.db);
  const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();

  // Assignee wake — skip when the author is the assignee (self-comment).
  const assigneeId = issue.assigneeAgentId;
  const authorIsAssignee =
    args.authorAgentId !== null && args.authorAgentId === assigneeId;
  if (assigneeId && !authorIsAssignee) {
    wakeups.set(assigneeId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId: args.issueId,
        commentId: args.refId,
        mutation: "comment",
      },
      requestedByActorType: args.authorAgentId
        ? "agent"
        : args.authorUserId
          ? "user"
          : "system",
      requestedByActorId:
        args.authorAgentId ?? args.authorUserId ?? "system",
      contextSnapshot: {
        issueId: args.issueId,
        taskId: args.issueId,
        commentId: args.refId,
        wakeCommentId: args.refId,
        source: "issue.comment",
        wakeReason: "issue_commented",
      },
    });
  }

  // Mentioned-agent wakes (skip the author).
  for (const mentionedId of args.mentionedAgentIds) {
    if (wakeups.has(mentionedId)) continue;
    if (args.authorAgentId && args.authorAgentId === mentionedId) continue;
    wakeups.set(mentionedId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId: args.issueId, commentId: args.refId },
      requestedByActorType: args.authorAgentId
        ? "agent"
        : args.authorUserId
          ? "user"
          : "system",
      requestedByActorId:
        args.authorAgentId ?? args.authorUserId ?? "system",
      contextSnapshot: {
        issueId: args.issueId,
        taskId: args.issueId,
        commentId: args.refId,
        wakeCommentId: args.refId,
        wakeReason: "issue_comment_mentioned",
        source: "comment.mention",
      },
    });
  }

  for (const [agentId, wakeup] of wakeups.entries()) {
    void heartbeat.wakeup(agentId, wakeup).catch(() => {
      // Wakeup failures are logged inside the service; swallow here so one
      // agent's failure does not block others.
    });
  }

  // Best-effort mark as processed so readers can tell at-a-glance in the
  // diagnose endpoint whether side effects fired for a ref.
  void deps.db
    .update(issueCommentRefs)
    .set({
      metadata: sql`COALESCE(${issueCommentRefs.metadata}, '{}'::jsonb) || jsonb_build_object('sideEffectsDispatchedAt', ${new Date().toISOString()}::text)`,
    })
    .where(
      and(
        eq(issueCommentRefs.id, args.refId),
        eq(issueCommentRefs.suppressedForWake, false),
      ),
    )
    .catch(() => {
      // best-effort audit marker only
    });
}
