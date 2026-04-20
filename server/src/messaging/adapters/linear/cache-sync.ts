import { and, eq } from "drizzle-orm";
import {
  issues as issuesTable,
  issueLabels,
} from "@paperclipai/db";
import type { Db } from "../../router.js";
import type { MessagingEvent } from "../../types.js";
import { findLinearLabelByExternalRef } from "./label-sync.js";
import {
  type WorkflowStateMap,
  invertWorkflowStateMap,
  mapLinearPriorityToPaperclip,
} from "./workflow-state-map.js";

export interface CacheSyncDeps {
  db: Db;
  companyId: string;
  workflowStateMap: WorkflowStateMap | null;
}

export async function syncFromLinearEvent(
  deps: CacheSyncDeps,
  event: MessagingEvent,
): Promise<void> {
  switch (event.kind) {
    case "issue_created":
      await upsertIssueFromEvent(deps, event);
      break;
    case "issue_updated":
    case "issue_assignee_changed":
      await updateIssueFromEvent(deps, event);
      break;
    case "issue_removed":
      await markIssueCancelled(deps, event.externalIssueRef);
      break;
    case "labels_changed":
      await syncLabelsFromEvent(deps, event);
      break;
    default:
      // Comment + reaction + attachment + project events are handled by the
      // existing events processor path (events.ts) or are no-ops here.
      break;
  }
}

async function upsertIssueFromEvent(
  deps: CacheSyncDeps,
  event: Extract<MessagingEvent, { kind: "issue_created" }>,
): Promise<void> {
  const [existing] = await deps.db
    .select()
    .from(issuesTable)
    .where(eq(issuesTable.linearIssueId, event.externalIssueRef))
    .limit(1);
  if (existing) return;
  await deps.db.insert(issuesTable).values({
    companyId: deps.companyId,
    title: "(syncing from Linear)",
    identifier: event.identifier,
    linearIssueId: event.externalIssueRef,
    linearIssueIdentifier: event.identifier,
    status: "todo",
  });
}

async function updateIssueFromEvent(
  deps: CacheSyncDeps,
  event: Extract<
    MessagingEvent,
    { kind: "issue_updated" | "issue_assignee_changed" }
  >,
): Promise<void> {
  const [existing] = await deps.db
    .select()
    .from(issuesTable)
    .where(eq(issuesTable.linearIssueId, event.externalIssueRef))
    .limit(1);
  if (!existing) return;

  const patch: Partial<typeof issuesTable.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (event.kind === "issue_updated") {
    if (event.title != null) patch.title = event.title;
    if (event.description !== undefined) patch.description = event.description;
    if (event.priority != null) {
      const mapped = mapLinearPriorityToPaperclip(event.priority);
      if (mapped !== null) patch.priority = mapped;
    }
    if (event.stateExternalRef != null && deps.workflowStateMap) {
      const status = invertWorkflowStateMap(deps.workflowStateMap)[event.stateExternalRef];
      if (status !== undefined) patch.status = status;
    }
  }

  await deps.db
    .update(issuesTable)
    .set(patch)
    .where(eq(issuesTable.id, existing.id));
}

async function markIssueCancelled(
  deps: CacheSyncDeps,
  externalIssueRef: string,
): Promise<void> {
  await deps.db
    .update(issuesTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(issuesTable.linearIssueId, externalIssueRef));
}

async function syncLabelsFromEvent(
  deps: CacheSyncDeps,
  event: Extract<MessagingEvent, { kind: "labels_changed" }>,
): Promise<void> {
  const [issue] = await deps.db
    .select()
    .from(issuesTable)
    .where(eq(issuesTable.linearIssueId, event.externalIssueRef))
    .limit(1);
  if (!issue) return;

  for (const externalRef of event.addedExternalLabelRefs) {
    const ref = await findLinearLabelByExternalRef(
      deps.db,
      deps.companyId,
      externalRef,
    );
    if (!ref) continue;
    await deps.db
      .insert(issueLabels)
      .values({
        companyId: deps.companyId,
        issueId: issue.id,
        labelId: ref.paperclipLabelId,
      })
      .onConflictDoNothing();
  }
  for (const externalRef of event.removedExternalLabelRefs) {
    const ref = await findLinearLabelByExternalRef(
      deps.db,
      deps.companyId,
      externalRef,
    );
    if (!ref) continue;
    await deps.db
      .delete(issueLabels)
      .where(
        and(
          eq(issueLabels.issueId, issue.id),
          eq(issueLabels.labelId, ref.paperclipLabelId),
        ),
      );
  }
}
