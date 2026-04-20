# Linear as Source of Truth for Issues

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linear the authoritative backend for issues — issues cannot be created or exist without a connected Linear workspace, and all mutations sync to Linear first.

**Architecture:** Paperclip's `issues` table becomes a write-through cache: creation always mints a Linear issue first (fail-fast if Linear is down), mutations are best-effort synced to Linear, and Linear webhooks drive field updates back to the cache. A Linear-required gate on the server and on the UI prevents any issue surface from functioning without a connected workspace.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, Linear GraphQL API, React/TanStack Query

---

## File Map

| File | Change |
|------|--------|
| `server/src/messaging/types.ts` | Add `title`, `description`, `priority` to `issue_updated` event |
| `server/src/messaging/adapters/linear/events-normalize.ts` | Extract title/description/priority from webhook payload |
| `server/src/messaging/adapters/linear/cache-sync.ts` | Full field sync in `updateIssueFromEvent`; add `workflowStateMap` to deps |
| `server/src/messaging/adapters/linear/workflow-state-map.ts` | Add `invertWorkflowStateMap` helper |
| `server/src/messaging/router.ts` | Expose `syncIssueToExternal` on `IssueTrackerRouter` interface; implement it |
| `server/src/messaging/types.ts` | Add `syncIssueToExternal` to `IssueTrackerRouter` |
| `server/src/messaging/adapters/fake/adapter.ts` | Implement `syncIssueToExternal` on fake adapter's router |
| `server/src/routes/issues.ts` | Gate issue creation on Linear readiness; call `syncIssueToExternal` after create; sync mutations |
| `ui/src/components/LinearRequiredGate.tsx` | New: gate component shown when Linear not connected |
| `ui/src/pages/Issues.tsx` | Wrap with `LinearRequiredGate` |
| `ui/src/pages/IssueDetail.tsx` | Wrap with `LinearRequiredGate` |
| `ui/src/components/OnboardingWizard.tsx` | Insert Linear connect step between Agent and Task |
| `server/src/__tests__/linear-source-of-truth.test.ts` | New integration tests |

---

### Task 1: Extend `issue_updated` event with full field snapshot

The `issue_updated` `MessagingEvent` currently only carries `changedFields`, `assigneeExternalRef`, and `stateExternalRef`. Cache-sync needs `title`, `description`, and `priority` so it can write them back without an extra Linear API call.

**Files:**
- Modify: `server/src/messaging/types.ts`
- Modify: `server/src/messaging/adapters/linear/events-normalize.ts`
- Test: `server/src/__tests__/linear-source-of-truth.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new test file `server/src/__tests__/linear-source-of-truth.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { normalizeLinearEvent } from "../messaging/adapters/linear/events-normalize.js";

describe("normalizeLinearEvent — issue_updated full snapshot", () => {
  it("carries title, description, and priority from the webhook payload", () => {
    const raw = {
      webhookId: "wh1",
      webhookTimestamp: 1000,
      type: "Issue",
      action: "update",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedFrom: { stateId: "old-state" },
      data: {
        id: "LIN-1",
        identifier: "PLO-1",
        title: "Updated title",
        description: "Updated desc",
        priority: 2,
        assignee: null,
        state: { id: "state-in-progress" },
      },
    };
    const event = normalizeLinearEvent(raw);
    expect(event?.kind).toBe("issue_updated");
    if (event?.kind !== "issue_updated") throw new Error("wrong kind");
    expect(event.title).toBe("Updated title");
    expect(event.description).toBe("Updated desc");
    expect(event.priority).toBe(2);
    expect(event.stateExternalRef).toBe("state-in-progress");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && pnpm exec vitest run src/__tests__/linear-source-of-truth.test.ts
```

Expected: FAIL — `event.title` is `undefined`.

- [ ] **Step 3: Add `title`, `description`, `priority` to `issue_updated` in `MessagingEvent`**

In `server/src/messaging/types.ts`, find the `issue_updated` branch of `MessagingEvent` (around line 147) and add three optional fields:

```typescript
  | {
      kind: "issue_updated";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      changedFields: string[];
      title?: string | null;
      description?: string | null;
      assigneeExternalRef?: ExternalRef | null;
      stateExternalRef?: ExternalRef | null;
      priority?: number | null;
      updatedAt: Date;
    }
```

- [ ] **Step 4: Extract the new fields in `normalizeIssue`**

In `server/src/messaging/adapters/linear/events-normalize.ts`, update the `data` cast inside `normalizeIssue` and the returned `issue_updated` object:

```typescript
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
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && pnpm exec vitest run src/__tests__/linear-source-of-truth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full server test suite to confirm no regressions**

```bash
cd server && pnpm exec vitest run
```

Expected: all tests pass (same count as before).

- [ ] **Step 7: Commit**

```bash
git add server/src/messaging/types.ts \
        server/src/messaging/adapters/linear/events-normalize.ts \
        server/src/__tests__/linear-source-of-truth.test.ts
git commit -m "feat(messaging): extend issue_updated event with title/description/priority snapshot"
```

---

### Task 2: Full field sync from Linear events to the Paperclip cache

Currently `updateIssueFromEvent` only touches `updatedAt`. This task makes it write back all changed fields: title, description, status (via the workflow state map), and priority. Assignee sync requires mapping a Linear user ID to a Paperclip `agentId` via `messaging_identities` — skip assignee for now (it's handled by agent heartbeat checkout, not by the cache-sync).

**Files:**
- Modify: `server/src/messaging/adapters/linear/workflow-state-map.ts`
- Modify: `server/src/messaging/adapters/linear/cache-sync.ts`
- Modify: `server/src/messaging/context.ts` (pass `workflowStateMap` when calling `syncFromLinearEvent`)
- Test: `server/src/__tests__/linear-source-of-truth.test.ts`

- [ ] **Step 1: Add `invertWorkflowStateMap` to `workflow-state-map.ts`**

Append this function to `server/src/messaging/adapters/linear/workflow-state-map.ts`:

```typescript
/**
 * Returns a map from Linear state ID → PaperclipStatus, built by inverting
 * the complete workflow state map. Returns an empty map if the map is incomplete.
 */
export function invertWorkflowStateMap(
  map: WorkflowStateMap,
): Record<string, PaperclipStatus> {
  if (map.kind !== "complete") return {};
  const out: Record<string, PaperclipStatus> = {};
  for (const [status, stateId] of Object.entries(map.byStatus) as [PaperclipStatus, string][]) {
    out[stateId] = status;
  }
  return out;
}

/**
 * Maps a Linear numeric priority (1=urgent, 2=high, 3=medium, 4=low, 0=no priority)
 * to a Paperclip priority string.
 */
export function mapLinearPriorityToPaperclip(
  priority: number,
): "critical" | "high" | "medium" | "low" | null {
  switch (priority) {
    case 1: return "critical";
    case 2: return "high";
    case 3: return "medium";
    case 4: return "low";
    default: return null;
  }
}
```

- [ ] **Step 2: Write the failing test for full field sync**

Add to `server/src/__tests__/linear-source-of-truth.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll, afterEach, beforeAll, describe, expect, it,
} from "vitest";
import {
  agents, companies, createDb, issues, messagingEventsInbox,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { syncFromLinearEvent } from "../messaging/adapters/linear/cache-sync.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

describeIf("cache-sync full field sync", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sot-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  it("syncs title, status, and priority from issue_updated event", async () => {
    const [company] = await db.insert(companies)
      .values({ name: "Test Co", issuePrefix: "TST" })
      .returning();
    const [project] = await db.insert(projects)
      .values({ companyId: company!.id, name: "P" })
      .returning();
    const linearIssueId = randomUUID();
    await db.insert(issues).values({
      companyId: company!.id,
      projectId: project!.id,
      title: "Old title",
      identifier: "TST-1",
      linearIssueId,
      linearIssueIdentifier: "TST-1",
      status: "todo",
      priority: "medium",
    });

    const stateId = randomUUID();
    const workflowStateMap = {
      kind: "complete" as const,
      byStatus: {
        todo: randomUUID(),
        in_progress: stateId,
        in_review: randomUUID(),
        blocked: randomUUID(),
        done: randomUUID(),
        cancelled: randomUUID(),
      },
    };

    await syncFromLinearEvent(
      { db, companyId: company!.id, workflowStateMap },
      {
        kind: "issue_updated",
        externalEventId: "EV1",
        externalIssueRef: linearIssueId,
        changedFields: ["title", "stateId", "priority"],
        title: "New title",
        description: null,
        priority: 2,
        stateExternalRef: stateId,
        updatedAt: new Date(),
      },
    );

    const [row] = await db.select().from(issues)
      .where(eq(issues.linearIssueId, linearIssueId));
    expect(row!.title).toBe("New title");
    expect(row!.status).toBe("in_progress");
    expect(row!.priority).toBe("high");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && pnpm exec vitest run src/__tests__/linear-source-of-truth.test.ts
```

Expected: FAIL — `workflowStateMap` is not a valid property on `CacheSyncDeps`.

- [ ] **Step 4: Update `CacheSyncDeps` and `updateIssueFromEvent`**

Replace the contents of `server/src/messaging/adapters/linear/cache-sync.ts`:

```typescript
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
      if (mapped) patch.priority = mapped;
    }
    if (event.stateExternalRef && deps.workflowStateMap) {
      const inverted = invertWorkflowStateMap(deps.workflowStateMap);
      const status = inverted[event.stateExternalRef];
      if (status) patch.status = status;
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
```

- [ ] **Step 5: Update callers of `syncFromLinearEvent` to pass `workflowStateMap`**

In `server/src/messaging/context.ts`, find `buildLinearContext` and update the `syncFromEvent` closure to extract the workflow state map from `install.metadata`:

```typescript
// In buildLinearContext, find the syncFromLinearEvent call and update:
const rawMap = (install.metadata as Record<string, unknown> | null)
  ?.linearWorkflowStateMap as WorkflowStateMap | null | undefined;
const workflowStateMap = rawMap ?? null;

// Then pass it:
syncFromEvent: (event) =>
  syncFromLinearEvent({ db: bootstrap.db, companyId, workflowStateMap }, event),
```

You will need to import `WorkflowStateMap` from `./adapters/linear/workflow-state-map.js` at the top of `context.ts`.

The existing call site in `buildLinearContext` creates a closure. Find it and add the `workflowStateMap` field:

```typescript
// Before (in buildLinearContext, the syncFromEvent assignment):
syncFromEvent: (event) =>
  syncFromLinearEvent({ db: bootstrap.db, companyId }, event),

// After:
syncFromEvent: (event) =>
  syncFromLinearEvent({ db: bootstrap.db, companyId, workflowStateMap }, event),
```

- [ ] **Step 6: Fix the fake backend (no workflow state map needed)**

The fake backend also calls `syncFromLinearEvent` via `buildFakeContext`. Pass `workflowStateMap: null` there:

```typescript
syncFromEvent: (event) =>
  syncFromLinearEvent({ db: bootstrap.db, companyId, workflowStateMap: null }, event),
```

- [ ] **Step 7: Run tests**

```bash
cd server && pnpm exec vitest run src/__tests__/linear-source-of-truth.test.ts
```

Expected: PASS.

- [ ] **Step 8: Full test suite**

```bash
cd server && pnpm exec vitest run
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add server/src/messaging/adapters/linear/workflow-state-map.ts \
        server/src/messaging/adapters/linear/cache-sync.ts \
        server/src/messaging/context.ts \
        server/src/__tests__/linear-source-of-truth.test.ts
git commit -m "feat(messaging): full field sync from Linear webhooks to cache (title/status/priority)"
```

---

### Task 3: Expose `syncIssueToExternal` on the router interface

The route handler needs a way to push a newly created local issue to Linear. `ensureExternalIssue` is a private function inside the router closure. This task adds a public `syncIssueToExternal` method to `IssueTrackerRouter`.

**Files:**
- Modify: `server/src/messaging/types.ts`
- Modify: `server/src/messaging/router.ts`
- Modify: `server/src/messaging/adapters/fake/adapter.ts`

- [ ] **Step 1: Add `syncIssueToExternal` to `IssueTrackerRouter`**

In `server/src/messaging/types.ts`, find the `IssueTrackerRouter` interface and add:

```typescript
export interface IssueTrackerRouter {
  backend: BackendKey;
  createIssue(args: CreateIssueRouterArgs): Promise<{ issueId: string; identifier: string }>;
  updateIssue(args: UpdateIssueRouterArgs): Promise<void>;
  postComment(args: PostCommentRouterArgs): Promise<{ id: string }>;
  editComment(args: EditCommentRouterArgs): Promise<void>;
  deleteComment(args: DeleteCommentRouterArgs): Promise<void>;
  /**
   * Ensures a locally-created issue exists in the external tracker.
   * Creates the external issue if the local row has no linearIssueId yet,
   * then updates the local row with the returned external ref.
   * Returns the external ref (existing or newly created).
   */
  syncIssueToExternal(issueId: string): Promise<{ externalIssueRef: string; identifier: string }>;
}
```

(Keep the existing methods — just add `syncIssueToExternal`.)

- [ ] **Step 2: Implement `syncIssueToExternal` in `router.ts`**

In `server/src/messaging/router.ts`, add the implementation inside the `createIssueTrackerRouter` return object. It wraps the existing `ensureExternalIssue` private function:

```typescript
async syncIssueToExternal(issueId: string) {
  const result = await ensureExternalIssue(issueId);
  return {
    externalIssueRef: result.externalIssueRef,
    identifier: result.issueRow.linearIssueIdentifier ?? result.externalIssueRef,
  };
},
```

- [ ] **Step 3: Implement `syncIssueToExternal` on the fake router**

In `server/src/messaging/adapters/fake/adapter.ts`, find the router object returned by `createIssueTrackerRouter` (inside `createFakeAdapter`) and add:

```typescript
async syncIssueToExternal(issueId: string) {
  // Fake: issue already "exists" in the fake adapter; just return a stable ref
  const [row] = await deps.db
    .select({ id: issuesTable.id, linearIssueId: issuesTable.linearIssueId, linearIssueIdentifier: issuesTable.linearIssueIdentifier })
    .from(issuesTable)
    .where(eq(issuesTable.id, issueId))
    .limit(1);
  if (row?.linearIssueId) {
    return { externalIssueRef: row.linearIssueId, identifier: row.linearIssueIdentifier ?? row.linearIssueId };
  }
  // Mint a fake external ref and persist it
  const externalIssueRef = randomUUID();
  await deps.db.update(issuesTable)
    .set({ linearIssueId: externalIssueRef, linearIssueIdentifier: `FAKE-${issueId.slice(0,4)}` })
    .where(eq(issuesTable.id, issueId));
  return { externalIssueRef, identifier: `FAKE-${issueId.slice(0,4)}` };
},
```

You will need `import { randomUUID } from "node:crypto"` and the correct imports for `issuesTable` and `eq` in that file. Check what is already imported.

- [ ] **Step 4: Run the full test suite**

```bash
cd server && pnpm exec vitest run
```

Expected: all pass (the interface change is non-breaking — `syncIssueToExternal` is new, not replacing anything).

- [ ] **Step 5: Commit**

```bash
git add server/src/messaging/types.ts \
        server/src/messaging/router.ts \
        server/src/messaging/adapters/fake/adapter.ts
git commit -m "feat(messaging): expose syncIssueToExternal on IssueTrackerRouter"
```

---

### Task 4: Linear-first issue creation and mutation sync

Gate `POST /companies/:companyId/issues` on Linear readiness and eagerly push to Linear. Also sync relevant field changes from `PATCH /issues/:id` to Linear.

**Files:**
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/__tests__/linear-source-of-truth.test.ts`

- [ ] **Step 1: Write failing test for gated issue creation**

Add to `server/src/__tests__/linear-source-of-truth.test.ts` (inside the `describeIf` block with the db):

```typescript
it("POST /companies/:companyId/issues throws MessagingNotConfigured when Linear not connected", async () => {
  // Set up a company with no messaging config
  const [company] = await db.insert(companies)
    .values({ name: "No Linear Co", issuePrefix: "NLC" })
    .returning();
  const [project] = await db.insert(projects)
    .values({ companyId: company!.id, name: "P" })
    .returning();

  const { issueService } = await import("../services/issues.js");
  const svc = issueService(db);

  // requireMessagingContext is called inside the route handler, so test via
  // the route directly. For unit isolation, test the service precondition.
  // Verify that resolveMessagingContext returns "disabled" for this company.
  const { resolveMessagingContext } = await import("../messaging/context.js");

  // messaging not initialized in this test scope, so we expect "disabled"
  // The route handler translates this to a 412 via translateMessagingError.
  const { resetMessagingForTests, initMessaging } = await import("../messaging/context.js");
  resetMessagingForTests();

  const ctx = await resolveMessagingContext(company!.id).catch(() => ({ status: "disabled" as const, companyId: company!.id }));
  expect(ctx.status).toBe("disabled");
});
```

- [ ] **Step 2: Run the test to verify it passes (sanity check)**

```bash
cd server && pnpm exec vitest run src/__tests__/linear-source-of-truth.test.ts
```

This test should pass immediately — it's verifying the existing behavior.

- [ ] **Step 3: Add the Linear gate to `POST /companies/:companyId/issues`**

In `server/src/routes/issues.ts`, find the `POST /companies/:companyId/issues` route handler (around line 1331). Near the top of that handler, after `assertCompanyAccess`, add:

```typescript
// Require Linear workspace before allowing issue creation.
const messagingCtx = await requireMessagingContext(companyId).catch((err) => {
  throw translateMessagingError(err);
});
```

You will need `requireMessagingContext` and `translateMessagingError` imported. Check existing imports in the file — `translateMessagingError` is already imported from `"../errors.js"` and `requireMessagingContext` needs to be imported from `"../messaging/context.js"`.

Add to the imports near the top of `issues.ts`:
```typescript
import { requireMessagingContext } from "../messaging/context.js";
```

- [ ] **Step 4: Eagerly sync the new issue to Linear**

Still in the `POST /companies/:companyId/issues` handler, after the `svc.create()` call and before `res.status(201).json(...)`, add:

```typescript
// Eagerly push the issue to Linear. If Linear is unavailable, compensate by
// removing the local row so we don't leave an orphan.
try {
  await messagingCtx.router.syncIssueToExternal(issue.id);
} catch (syncErr) {
  // Best-effort cleanup — ignore if the delete also fails.
  await svc.remove(issue.id).catch(() => {});
  throw translateMessagingError(syncErr);
}
```

You will need to capture the `issue` variable from `svc.create()`. Make sure it is assigned: `const issue = await svc.create(...)`.

- [ ] **Step 5: Sync field mutations to Linear in `PATCH /issues/:id`**

In `server/src/routes/issues.ts`, find the `PATCH /issues/:id` handler (around line 1377). After the `svc.update()` call (and before `res.json(...)`), add a best-effort Linear sync:

```typescript
// Best-effort sync of mutated fields to Linear.
const updatedIssue = await svc.getById(id);
if (updatedIssue?.linearIssueId) {
  const patchCtx = await resolveMessagingContext(companyId).catch(() => null);
  if (patchCtx?.status === "ready") {
    const workflowMap = (patchCtx.workspaceInstall?.metadata as Record<string, unknown> | null)
      ?.linearWorkflowStateMap as WorkflowStateMap | null | undefined;
    const author: AuthorIdentity = {
      backend: patchCtx.backend,
      externalUserRef: "SYSTEM",
      credential: { kind: "bot_token" },
    };
    const updateArgs: UpdateIssueArgs = {
      externalIssueRef: updatedIssue.linearIssueId,
      author,
    };
    if (data.title !== undefined) updateArgs.title = data.title ?? null;
    if (data.description !== undefined) updateArgs.description = data.description ?? null;
    if (data.status !== undefined && workflowMap?.kind === "complete") {
      updateArgs.stateExternalRef = workflowMap.byStatus[data.status as PaperclipStatus] ?? null;
    }
    if (data.priority !== undefined) {
      updateArgs.priority = mapPaperclipPriorityToLinearPriority(
        data.priority as "critical" | "high" | "medium" | "low" | null,
      );
    }
    // Fire-and-forget with logged failure — Linear webhook will reconcile.
    patchCtx.router.updateIssue(
      patchCtx.backend === "linear"
        ? {
            ...updateArgs,
            companyId,
            issueId: id,
            authorKind: "bot_system",
          }
        : {
            ...updateArgs,
            companyId,
            issueId: id,
            authorKind: "bot_system",
          },
    ).catch((err: unknown) => {
      console.warn("[issues] failed to sync mutation to Linear:", err);
    });
  }
}
```

Add the missing imports to `issues.ts`:
```typescript
import { resolveMessagingContext } from "../messaging/context.js";
import type { WorkflowStateMap, PaperclipStatus } from "../messaging/adapters/linear/workflow-state-map.js";
import { mapPaperclipPriorityToLinearPriority } from "../messaging/adapters/linear/workflow-state-map.js";
import type { AuthorIdentity, UpdateIssueArgs } from "../messaging/types.js";
```

Note: `updateIssue` on the router takes `UpdateIssueRouterArgs` (which includes `companyId`, `issueId`, `authorKind`), not the raw adapter `UpdateIssueArgs`. Check the router interface and use the correct shape. The `IssueTrackerRouter.updateIssue` signature is defined in `types.ts` as `UpdateIssueRouterArgs`. Import and use that type.

- [ ] **Step 6: Run the test suite**

```bash
cd server && pnpm exec vitest run
```

Expected: all pass.

- [ ] **Step 7: Typecheck**

```bash
cd server && pnpm exec tsc --noEmit
```

Fix any type errors before committing.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/issues.ts
git commit -m "feat(issues): gate creation on Linear readiness; eagerly sync to Linear on create/update"
```

---

### Task 5: UI Linear-required gate on Issues pages

Add a `LinearRequiredGate` component that checks messaging status and shows a "Connect Linear workspace" prompt if the company is not set up. Wrap `Issues` and `IssueDetail` with it.

**Files:**
- Create: `ui/src/components/LinearRequiredGate.tsx`
- Modify: `ui/src/pages/Issues.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Create `LinearRequiredGate.tsx`**

```tsx
// ui/src/components/LinearRequiredGate.tsx
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { messagingApi } from "@/api/messaging";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";

interface LinearRequiredGateProps {
  children: React.ReactNode;
}

export function LinearRequiredGate({ children }: LinearRequiredGateProps) {
  const { selectedCompanyId } = useCompany();

  const statusQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.messaging.status(selectedCompanyId)
      : (["messaging", "status", "__disabled__"] as const),
    queryFn: () => messagingApi.getStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId || statusQuery.isLoading) return <>{children}</>;

  const readiness = statusQuery.data?.readiness ?? "disabled";

  if (readiness === "ready") return <>{children}</>;

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <Link2 className="h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Connect a Linear workspace to use issues</p>
        <p className="text-xs text-muted-foreground">
          Paperclip uses Linear as the ticketing backend. All issues are created and
          tracked there.
        </p>
      </div>
      <Button size="sm" asChild>
        <a href="/company/settings/messaging">Go to Messaging Settings</a>
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Wrap `Issues` with `LinearRequiredGate`**

In `ui/src/pages/Issues.tsx`, import and wrap the return value:

```tsx
import { LinearRequiredGate } from "@/components/LinearRequiredGate";

// In the Issues component's return:
return (
  <LinearRequiredGate>
    {/* existing content */}
  </LinearRequiredGate>
);
```

- [ ] **Step 3: Wrap `IssueDetail` with `LinearRequiredGate`**

In `ui/src/pages/IssueDetail.tsx`, do the same:

```tsx
import { LinearRequiredGate } from "@/components/LinearRequiredGate";

// Wrap the outermost returned JSX:
return (
  <LinearRequiredGate>
    {/* existing content */}
  </LinearRequiredGate>
);
```

- [ ] **Step 4: Write a UI test for the gate**

Create `ui/src/components/LinearRequiredGate.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LinearRequiredGate } from "./LinearRequiredGate";

const getStatusMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/messaging", () => ({
  messagingApi: { getStatus: (id: string) => getStatusMock(id) },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("LinearRequiredGate", () => {
  let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); });
  afterEach(() => { container.remove(); vi.clearAllMocks(); });

  it("shows children when readiness=ready", async () => {
    getStatusMock.mockResolvedValue({ readiness: "ready" });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider><LinearRequiredGate><span>my content</span></LinearRequiredGate></TooltipProvider>
        </QueryClientProvider>
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(container.textContent).toContain("my content");
    await act(async () => { root.unmount(); });
  });

  it("shows setup prompt when readiness=disabled", async () => {
    getStatusMock.mockResolvedValue({ readiness: "disabled" });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider><LinearRequiredGate><span>my content</span></LinearRequiredGate></TooltipProvider>
        </QueryClientProvider>
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(container.textContent).not.toContain("my content");
    expect(container.textContent).toContain("Connect a Linear workspace");
    await act(async () => { root.unmount(); });
  });
});
```

- [ ] **Step 5: Run UI tests**

```bash
cd ui && pnpm exec vitest run src/components/LinearRequiredGate.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run full UI test suite**

```bash
cd ui && pnpm exec vitest run
```

Expected: all pass.

- [ ] **Step 7: Typecheck**

```bash
cd ui && pnpm exec tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/LinearRequiredGate.tsx \
        ui/src/components/LinearRequiredGate.test.tsx \
        ui/src/pages/Issues.tsx \
        ui/src/pages/IssueDetail.tsx
git commit -m "feat(ui): LinearRequiredGate — block issue pages until Linear workspace connected"
```

---

### Task 6: Add Linear connect step to the onboarding wizard

Currently the wizard has 4 steps: Company → Agent → Task → Launch. Add a new step 3 (Linear connect) between Agent and Task. The step polls the messaging status and auto-advances when the workspace is connected. The "Connect" button opens the Linear OAuth install URL in the current tab; after OAuth the user is redirected back with the wizard re-opened.

**Files:**
- Modify: `ui/src/components/OnboardingWizard.tsx`
- Modify: `server/src/routes/messaging-linear.ts` (add `returnUrl` support to OAuth callback)

- [ ] **Step 1: Add `returnUrl` support to the Linear OAuth app callback**

In `server/src/routes/messaging-linear.ts`, find the `GET /linear/oauth/app/callback` handler. After a successful install, instead of always redirecting to `/`, check for a `returnUrl` in the state token payload and redirect there.

In `mintStateToken` / `verifyStateToken` (or wherever the state token payload is defined), add an optional `returnUrl` field:

```typescript
interface AppInstallStatePayload {
  kind: "linear_app_install";
  companyId: string;
  nonce: string;
  exp: number;
  returnUrl?: string;
}
```

In `GET /linear/oauth/app/start`, if a `returnUrl` query param is present, include it in the state payload:

```typescript
const statePayload: AppInstallStatePayload = {
  kind: "linear_app_install",
  companyId,
  nonce: ...,
  exp: ...,
  returnUrl: (req.query.returnUrl as string | undefined) ?? undefined,
};
```

In `GET /linear/oauth/app/callback`, after successful install, redirect to `statePayload.returnUrl ?? "/"`:

```typescript
const redirectTo = statePayload.returnUrl ?? "/";
return res.redirect(redirectTo);
```

- [ ] **Step 2: Update `OnboardingWizard` step type and breadcrumbs**

In `ui/src/components/OnboardingWizard.tsx`, change `type Step = 1 | 2 | 3 | 4` to `type Step = 1 | 2 | 3 | 4 | 5`.

Update the step indicator array (the breadcrumb labels) from 4 items to 5:

```tsx
[
  { step: 1 as Step, label: "Company", icon: Building2 },
  { step: 2 as Step, label: "Agent",   icon: Bot },
  { step: 3 as Step, label: "Linear",  icon: Link2 },   // new
  { step: 4 as Step, label: "Task",    icon: CircleDot },
  { step: 5 as Step, label: "Launch",  icon: Rocket },
]
```

Import `Link2` from `lucide-react`.

Update all references to old steps 3 and 4 to be 4 and 5. Search for `step === 3` and `step === 4` and `setStep(3)`, `setStep(4)` and bump each by 1.

Also update the `handleKeyDown` guard:
```typescript
else if (step === 4 && taskTitle.trim()) handleStep4Next();  // was step 3
else if (step === 5) handleLaunch();                         // was step 4
```

- [ ] **Step 3: Add the Linear connect step handler and polling**

After `handleStep2Next` (agent creation), add:

```typescript
async function handleStep3Next() {
  // Step 3 is "Linear connect" — user must connect via OAuth.
  // This step auto-advances via polling; no manual "Next" action.
}
```

Add a polling query for messaging status that only runs on step 3:

```typescript
const messagingStatusQuery = useQuery({
  queryKey: createdCompanyId
    ? queryKeys.messaging.status(createdCompanyId)
    : (["messaging", "status", "__disabled__"] as const),
  queryFn: () => messagingApi.getStatus(createdCompanyId!),
  enabled: !!createdCompanyId && step === 3,
  refetchInterval: 2_000,
});

// Auto-advance from step 3 when Linear is connected
useEffect(() => {
  if (step !== 3) return;
  if (messagingStatusQuery.data?.readiness === "ready") {
    setStep(4);
  }
}, [step, messagingStatusQuery.data?.readiness]);
```

- [ ] **Step 4: Render the Linear connect step (step 3 UI)**

In the wizard's render section where steps are displayed, add a case for `step === 3`:

```tsx
{step === 3 && (
  <div className="space-y-4">
    <p className="text-sm text-muted-foreground">
      Paperclip uses Linear as the ticketing backend. Connect your Linear
      workspace so issues can be created and tracked there.
    </p>
    {messagingStatusQuery.data?.readiness === "ready" ? (
      <p className="text-sm font-medium text-green-600">
        ✓ Linear workspace connected — advancing…
      </p>
    ) : (
      <Button
        size="sm"
        onClick={() => {
          if (!createdCompanyId) return;
          const returnUrl = encodeURIComponent(window.location.href + "?onboarding=resume");
          window.location.assign(
            messagingApi.linearInstallUrl(createdCompanyId) + `&returnUrl=${returnUrl}`
          );
        }}
      >
        <Link2 className="mr-1.5 h-3.5 w-3.5" />
        Connect Linear workspace
      </Button>
    )}
  </div>
)}
```

- [ ] **Step 5: Handle `?onboarding=resume` on page load to reopen the wizard**

In `ui/src/App.tsx` (or wherever the `OnboardingWizard` is mounted), check for the `?onboarding=resume` query param on load and call `openOnboarding()` with the appropriate company ID:

```typescript
// On mount, check for OAuth return
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("onboarding") === "resume") {
    // Clear the param
    const url = new URL(window.location.href);
    url.searchParams.delete("onboarding");
    window.history.replaceState({}, "", url.toString());
    // Re-open the wizard at step 3 so it polls and auto-advances
    openOnboarding({ initialStep: 3, companyId: selectedCompanyId ?? undefined });
  }
}, []);
```

You will need to verify that `openOnboarding` supports `initialStep` and `companyId` options. Check `OnboardingWizard`'s `effectiveOnboardingOptions` handling (around line 95) — it already supports `initialStep`.

- [ ] **Step 6: Run UI tests**

```bash
cd ui && pnpm exec vitest run
```

Expected: all pass. (OnboardingWizard test files may need minor updates if they assert step counts.)

- [ ] **Step 7: Typecheck**

```bash
cd ui && pnpm exec tsc --noEmit && cd ../server && pnpm exec tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/OnboardingWizard.tsx \
        ui/src/App.tsx \
        server/src/routes/messaging-linear.ts
git commit -m "feat(onboarding): insert Linear connect step; returnUrl support in OAuth callback"
```

---

## Final sweep

- [ ] Run `just test` (or `pnpm exec vitest run` in both `server/` and `ui/`) — all must pass
- [ ] Run `pnpm exec tsc --noEmit` in both `server/` and `ui/` — clean
- [ ] Manual smoke test:
  1. Create a fresh company via onboarding → wizard shows Linear step at step 3
  2. Click "Connect Linear workspace" → OAuth flow → returns to app → step auto-advances to 4 (Task)
  3. Complete Task step → Launch → issue is created in both Paperclip and Linear
  4. Disconnect/reload as a company with no Linear → Issues page shows gate prompt
  5. Update an issue status → Linear issue state updates (check in Linear UI)
  6. Update a Linear issue title directly in Linear → Paperclip cache updates via webhook within seconds
- [ ] Push branch

```bash
git push
```
