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
    linearIssueId: event.externalIssueRef,
    linearIssueIdentifier: event.identifier,
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
    // title/description/priority/status columns dropped in Task 3 — Linear is now source of truth.
    // Status side effects (startedAt/completedAt/cancelledAt) will be handled by Task 7+.
    if (event.stateExternalRef != null && deps.workflowStateMap) {
      const status = invertWorkflowStateMap(deps.workflowStateMap)[event.stateExternalRef];
      if (status === "done") patch.completedAt = new Date();
      else if (status === "cancelled") patch.cancelledAt = new Date();
      else if (status === "in_progress") patch.startedAt = new Date();
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
    .set({ cancelledAt: new Date(), updatedAt: new Date() })
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
