import type { LinearWebhookEnvelope } from "./types.js";
import type { MessagingEvent } from "../../types.js";

export function normalizeLinearEvent(raw: unknown): MessagingEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw as LinearWebhookEnvelope & {
    updatedFrom?: Record<string, unknown>;
  };
  if (!env.webhookId || !env.webhookTimestamp) return null;
  const eventId = `linear-wh-${env.webhookId}-${env.webhookTimestamp}`;
  const at = env.createdAt ? new Date(env.createdAt) : new Date();

  switch (env.type) {
    case "Comment":
      return normalizeComment(env, eventId, at);
    case "Issue":
      return normalizeIssue(env, eventId, at);
    case "IssueLabel":
      return normalizeIssueLabel(env, eventId, at);
    case "Reaction":
      return normalizeReaction(env, eventId, at);
    case "Attachment":
      return normalizeAttachment(env, eventId, at);
    case "Project":
      return normalizeProject(env, eventId, at);
    default:
      return null;
  }
}

function normalizeComment(
  env: LinearWebhookEnvelope & { updatedFrom?: Record<string, unknown> },
  eventId: string,
  at: Date,
): MessagingEvent | null {
  const data = env.data as {
    id: string;
    body: string;
    createdAt: string;
    updatedAt?: string;
    editedAt?: string | null;
    user?: { id: string };
    issue: { id: string };
  };
  if (env.action === "create") {
    const mentionedExternalRefs = extractLinearMentions(data.body);
    return {
      kind: "comment_created",
      externalEventId: eventId,
      externalIssueRef: data.issue.id,
      externalCommentRef: data.id,
      authorExternalRef: data.user?.id ?? "",
      bodyRaw: data.body,
      mentionedExternalRefs,
      createdAt: new Date(data.createdAt),
    };
  }
  if (env.action === "update") {
    return {
      kind: "comment_updated",
      externalEventId: eventId,
      externalCommentRef: data.id,
      externalIssueRef: data.issue.id,
      bodyRaw: data.body,
      editedAt: data.editedAt ? new Date(data.editedAt) : at,
    };
  }
  if (env.action === "remove") {
    return {
      kind: "comment_deleted",
      externalEventId: eventId,
      externalCommentRef: data.id,
      externalIssueRef: data.issue.id,
      deletedAt: at,
    };
  }
  return null;
}

function normalizeIssue(
  env: LinearWebhookEnvelope & { updatedFrom?: Record<string, unknown> },
  eventId: string,
  at: Date,
): MessagingEvent | null {
  const data = env.data as {
    id: string;
    identifier: string;
    title?: string | null;
    description?: string | null;
    priority?: number | null;
    assignee?: { id: string } | null;
    state?: { id: string } | null;
  };
  if (env.action === "create") {
    return {
      kind: "issue_created",
      externalEventId: eventId,
      externalIssueRef: data.id,
      identifier: data.identifier,
      title: data.title ?? null,
      assigneeExternalRef: data.assignee?.id ?? null,
      createdAt: at,
    };
  }
  if (env.action === "remove") {
    return {
      kind: "issue_removed",
      externalEventId: eventId,
      externalIssueRef: data.id,
      removedAt: at,
    };
  }
  if (env.action === "update") {
    const updatedFrom = env.updatedFrom ?? {};
    const assigneeChanged = "assigneeId" in updatedFrom;
    if (assigneeChanged) {
      return {
        kind: "issue_assignee_changed",
        externalEventId: eventId,
        externalIssueRef: data.id,
        newAssigneeExternalRef: data.assignee?.id ?? null,
        updatedAt: at,
      };
    }
    const changedFields = Object.keys(updatedFrom);
    return {
      kind: "issue_updated",
      externalEventId: eventId,
      externalIssueRef: data.id,
      changedFields,
      title: data.title ?? null,
      description: data.description ?? null,
      priority: data.priority ?? null,
      assigneeExternalRef: data.assignee?.id ?? undefined,
      stateExternalRef: data.state?.id ?? undefined,
      updatedAt: at,
    };
  }
  return null;
}

function normalizeIssueLabel(
  env: LinearWebhookEnvelope,
  eventId: string,
  at: Date,
): MessagingEvent | null {
  const data = env.data as { issueId?: string; labelId?: string };
  if (!data.issueId || !data.labelId) return null;
  const added = env.action === "create" ? [data.labelId] : [];
  const removed = env.action === "remove" ? [data.labelId] : [];
  return {
    kind: "labels_changed",
    externalEventId: eventId,
    externalIssueRef: data.issueId,
    addedExternalLabelRefs: added,
    removedExternalLabelRefs: removed,
    updatedAt: at,
  };
}

function normalizeReaction(
  env: LinearWebhookEnvelope,
  eventId: string,
  at: Date,
): MessagingEvent | null {
  const data = env.data as {
    id: string;
    emoji?: string;
    comment?: { id: string; issue?: { id: string } };
    user?: { id: string };
  };
  if (!data.comment?.id || !data.emoji) return null;
  return {
    kind: env.action === "create" ? "reaction_added" : "reaction_removed",
    externalEventId: eventId,
    externalCommentRef: data.comment.id,
    externalIssueRef: data.comment.issue?.id ?? "",
    reactorExternalRef: data.user?.id ?? "",
    emoji: data.emoji,
    at,
  };
}

function normalizeAttachment(
  env: LinearWebhookEnvelope,
  eventId: string,
  at: Date,
): MessagingEvent | null {
  const data = env.data as { id: string; issueId?: string };
  if (!data.issueId) return null;
  return {
    kind: "attachment_changed",
    externalEventId: eventId,
    externalIssueRef: data.issueId,
    externalAttachmentRef: data.id,
    action: env.action === "create" ? "added" : "removed",
    updatedAt: at,
  };
}

function normalizeProject(
  env: LinearWebhookEnvelope,
  eventId: string,
  at: Date,
): MessagingEvent | null {
  const data = env.data as { id: string };
  return {
    kind: "project_changed",
    externalEventId: eventId,
    externalProjectRef: data.id,
    action:
      env.action === "create"
        ? "created"
        : env.action === "update"
          ? "updated"
          : "removed",
    updatedAt: at,
  };
}

const LINEAR_MENTION_RE = /@\[([^\]]+)\]\(mention-([^)]+)\)/g;

export function extractLinearMentions(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(LINEAR_MENTION_RE)) {
    const id = match[2];
    if (id) ids.push(id);
  }
  return ids;
}
