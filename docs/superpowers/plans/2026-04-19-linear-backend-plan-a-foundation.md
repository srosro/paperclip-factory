# Linear Backend Migration — Plan A: Foundation Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Slack adapter, refactor Paperclip's messaging schema from Slack-shaped (channels / threads / messages) to issue-centric (issues + issue_comment_refs), and rename the adapter interface from `MessagingAdapter` to `IssueTrackerAdapter`. At the end of this plan, Paperclip builds, all non-Slack tests are green, the `FakeAdapter` is retargeted to the new interface — but no real backend is yet wired up. That's the deliberate interim state.

**Architecture:** Branch from `feat/slack-first-comms` into `feat/linear-backend` (already done). Refactor sequentially in commits small enough that each reaches a green-test state. Interface rename first with a type alias so call sites compile, then method-list swap, then Slack deletion, then schema refactor. Plans B and C (separate files) add the Linear adapter and Plow migration after this one lands.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, drizzle-orm + drizzle-kit, embedded-postgres for tests, Express on server, React + Vite on UI.

**Predecessor spec:** `docs/superpowers/specs/2026-04-19-linear-backend-migration-design.md`

---

## Context

- **Branch:** `feat/linear-backend` — already checked out at `0d91ae7c` (spec commit).
- **Old branch:** `feat/slack-first-comms` — stays on the fork. Never merge back; it's the Slack-era reference.
- **Test command:** `pnpm -w test -- --run <path>` from the repo root. Embedded-postgres tests auto-start a local Postgres cluster.
- **DB migrations:** `pnpm db:generate` regenerates migrations from schema changes. `pnpm db:migrate` applies pending migrations against the configured Postgres (wakeup's embedded cluster during runtime).
- **CLAUDE.md rules that apply:** never use `git worktree`, never use `git checkout/reset/clean`/destructive git unless the user asked by name, run `just test` / `pnpm -w test` before returning to the user.
- **Important subtlety:** the current branch still has Slack code compiled in. The first phase of this plan (Tasks 1–4) is pure deletion; intermediate states between Tasks 1–4 compile but have dead references. Each task commits independently so `git bisect` works if something breaks.

---

## File Structure

**Files to DELETE:**

```
server/src/messaging/adapters/slack/
  adapter.ts
  client.ts
  file-ingest.ts
  mention-parser.ts
  mrkdwn.ts
  signing.ts
  token-store.ts
server/src/routes/messaging-slack.ts
server/src/messaging/inbox.ts
server/scripts/slack-smoke.ts
server/scripts/plow-dev-bootstrap.ts
server/scripts/plow-dev-finish.ts
server/src/__tests__/slack-oauth-routes.test.ts
server/src/__tests__/slack-events-webhook.test.ts
server/src/__tests__/slack-adapter-capabilities.test.ts
server/src/__tests__/slack-mention-parser.test.ts
server/src/__tests__/inbox-routes.test.ts
server/src/__tests__/inbox-service.test.ts
packages/db/src/schema/messaging_channels.ts
packages/db/src/schema/messaging_threads.ts
packages/db/src/schema/messaging_message_refs.ts
server/src/messaging/adapters/slack/app-manifest.json
```

**Files to CREATE:**

```
packages/db/src/schema/issue_comment_refs.ts
packages/db/src/schema/messaging_label_refs.ts
packages/db/src/migrations/0061_linear_backend_foundation.sql  (drizzle-generated)
server/src/__tests__/issue-tracker-adapter-interface.test.ts
```

**Files to MODIFY:**

```
server/src/messaging/types.ts                         # Interface rename + redesign
server/src/messaging/router.ts                        # Swap channel/thread for issue/comment primitives
server/src/messaging/events.ts                        # Change lookup path (issue_comment_refs, no threads)
server/src/messaging/context.ts                       # Drop Slack-specific deps
server/src/messaging/index.ts                         # Export surface cleanup
server/src/messaging/side-effects.ts                  # Update ref table name
server/src/messaging/adapters/fake/adapter.ts         # Implement IssueTrackerAdapter
server/src/services/issues.ts                         # Call new router shape
server/src/services/heartbeat.ts                      # Update ref-table joins
server/src/services/feedback.ts                       # Update ref-table joins
server/src/routes/issues.ts                           # Drop Slack-specific attachment flow
server/src/routes/messaging-admin.ts                  # Drop channel-based diagnose
server/src/app.ts                                     # Drop Slack env plumbing + inbox hook
packages/db/src/schema/index.ts                       # Rename exports
packages/db/src/schema/issues.ts                      # Add linear_issue_id + linear_issue_identifier
packages/db/src/schema/projects.ts                    # Add linear_project_id
packages/db/src/schema/feedback_votes.ts              # Retarget FK to issue_comment_refs
packages/db/src/schema/issue_attachments.ts           # Retarget FK to issue_comment_refs
ui/src/pages/SettingsMessaging.tsx                    # Drop Slack UI + Slack api calls; stub Linear UI
ui/src/api/messaging.ts                               # Update types; rename Slack fields
server/src/__tests__/messaging-router.test.ts         # Adapt to new interface
server/src/__tests__/messaging-events.test.ts         # Adapt to new interface
server/src/__tests__/messaging-hardening.test.ts      # Adapt to new interface; drop Slack-specific assertions
server/src/__tests__/messaging-e2e-fake.test.ts       # Adapt to new interface
server/src/__tests__/messaging-thread-lock.test.ts    # Delete (thread-lock is gone)
server/src/__tests__/messaging-admin-status.test.ts   # Adapt (drop Slack-ness)
server/src/__tests__/messaging-error-mapping.test.ts  # Drop MessagingThreadLocked mapping
server/src/__tests__/helpers/messaging-test-seed.ts   # Adapt to new interface
ui/src/pages/SettingsMessaging.test.tsx               # Adapt to Linear-shaped expectations
```

---

## Phase plan (task list preview)

- **Task 1** — Branch sanity check + install check
- **Task 2** — Rename `MessagingAdapter` → `IssueTrackerAdapter` (type alias shim, both names exist)
- **Task 3** — Delete Slack adapter files (first big deletion)
- **Task 4** — Delete Slack routes + inbox + app.ts Slack plumbing
- **Task 5** — Delete Slack tests + helper scripts
- **Task 6** — Schema refactor: create new tables + copy migration
- **Task 7** — Drop old Slack-era schema tables
- **Task 8** — Retarget FKs (`feedback_votes`, `issue_attachments`) to new comment-refs table
- **Task 9** — Rewrite the new `IssueTrackerAdapter` interface properly (no more alias)
- **Task 10** — Refactor router + events + services + FakeAdapter to the new interface
- **Task 11** — Stub Linear UI panel; retire Slack UI surfaces
- **Task 12** — Final test sweep + commit

---

## Task 1: Branch sanity check

**Files:** none touched; verification only.

- [ ] **Step 1: Confirm branch and starting commit**

```bash
git status
git log --oneline -1
```

Expected:
```
On branch feat/linear-backend
Your branch is up to date with 'factory/feat/linear-backend'.
nothing to commit, working tree clean

0d91ae7c docs(messaging): resolve open questions in Linear migration spec
```

If not on `feat/linear-backend`, stop — something's wrong.

- [ ] **Step 2: Confirm the full test suite is green on this starting point**

```bash
pnpm -w test -- --run server/ ui/ 2>&1 | tail -15
```

Expected (approximate): `Tests  1059 passed | 2 skipped (1061)` for server, plus ~500 UI tests passing.

If any tests fail here, they're pre-existing and need to be understood before proceeding.

- [ ] **Step 3: Confirm typecheck is clean**

```bash
pnpm typecheck 2>&1 | grep -E "error" | head
```

Expected: no error lines.

- [ ] **Step 4: Record current DB migration state**

```bash
ls packages/db/src/migrations/*.sql | tail -5
```

Expected: `0060_broad_viper.sql` is the latest. New migration in Task 6 will be `0061_…`.

No commit — this task is read-only verification.

---

## Task 2: Rename `MessagingAdapter` → `IssueTrackerAdapter` (alias stage)

Keep both names briefly so call sites don't all break at once. Purpose: the type ends up renamed without touching every consumer yet.

**Files:**
- Modify: `server/src/messaging/types.ts`

- [ ] **Step 1: Write a failing test**

Create: `server/src/__tests__/issue-tracker-adapter-interface.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import type {
  IssueTrackerAdapter,
  MessagingAdapter,
} from "../messaging/types.js";

describe("IssueTrackerAdapter interface", () => {
  it("is exported from messaging/types and is structurally compatible with MessagingAdapter", () => {
    // Compile-time: if IssueTrackerAdapter doesn't exist or isn't assignable
    // from MessagingAdapter, this file fails to typecheck.
    type AssertAssignable = MessagingAdapter extends IssueTrackerAdapter
      ? true
      : false;
    const ok: AssertAssignable = true;
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and see it fail to compile**

```bash
pnpm -w test -- --run server/src/__tests__/issue-tracker-adapter-interface.test.ts 2>&1 | tail -10
```

Expected: `error TS2724: Module '"../messaging/types.js"' has no exported member 'IssueTrackerAdapter'`.

- [ ] **Step 3: Add `IssueTrackerAdapter` as an alias in `server/src/messaging/types.ts`**

Append to the file, after the existing `MessagingAdapter` interface definition:

```typescript
/**
 * IssueTrackerAdapter is the target name for this interface post-refactor.
 * During the refactor, it's an alias so callers can migrate incrementally.
 * After the refactor completes (Task 10), MessagingAdapter is removed and
 * only IssueTrackerAdapter remains, with the redesigned method surface.
 */
export type IssueTrackerAdapter = MessagingAdapter;
```

- [ ] **Step 4: Run the test — it passes**

```bash
pnpm -w test -- --run server/src/__tests__/issue-tracker-adapter-interface.test.ts 2>&1 | tail -5
```

Expected: `Tests  1 passed (1)`.

- [ ] **Step 5: Run the full server test suite to confirm nothing regressed**

```bash
pnpm -w test -- --run server/ 2>&1 | tail -5
```

Expected: still 1059+ passing.

- [ ] **Step 6: Commit**

```bash
git add server/src/messaging/types.ts server/src/__tests__/issue-tracker-adapter-interface.test.ts
git commit -m "refactor(messaging): introduce IssueTrackerAdapter as alias for MessagingAdapter

First step of the interface rename. IssueTrackerAdapter is a type
alias so existing MessagingAdapter callers continue to compile.
The method surface gets redesigned in Task 10."
```

---

## Task 3: Delete the Slack adapter code

**Files:**
- Delete: `server/src/messaging/adapters/slack/` (entire directory)
- Modify: `server/src/messaging/context.ts` (drop Slack imports)

- [ ] **Step 1: Inspect what currently imports from the Slack adapter**

```bash
grep -rn "adapters/slack/" server/src/ 2>&1 | grep -v __tests__ | head -20
```

Expected output includes imports in `context.ts`, possibly `app.ts`, `routes/messaging-slack.ts`. Those files get updated as we delete — note them.

- [ ] **Step 2: Delete the Slack adapter directory**

```bash
rm -rf server/src/messaging/adapters/slack/
```

- [ ] **Step 3: Remove Slack imports from `context.ts`**

Open `server/src/messaging/context.ts`. Delete these imports at the top:

```typescript
import { createSlackAdapter } from "./adapters/slack/adapter.js";
import { resolveSlackMentions, rewriteOutboundBodyForSlack } from "./adapters/slack/mention-parser.js";
import { createSlackFileIngest } from "./adapters/slack/file-ingest.js";
```

Then delete the `buildSlackContext` function inside the file (the helper that builds per-company Slack contexts — it references Slack-specific modules).

And in `resolveMessagingContext`, delete the entire `if (backend === "slack") { ... }` branch so only the `backend === "fake"` branch remains. If the function currently can resolve to a `'slack'` backend, change it to return `{ status: 'disabled', companyId }` for any `active_backend` value other than `'fake'` (we'll add Linear resolution in Plan B).

- [ ] **Step 4: Typecheck — it will still fail (expected)**

```bash
pnpm typecheck 2>&1 | grep -E "error" | head
```

Expected: errors from `routes/messaging-slack.ts` and `app.ts` referring to deleted Slack resolvers. We fix those in Task 4.

- [ ] **Step 5: Commit with the broken intermediate state noted**

```bash
git add -A
git commit -m "refactor(messaging): delete Slack adapter module

Removes server/src/messaging/adapters/slack/* and the Slack-specific
context builder in context.ts. Routes and app.ts still reference
Slack plumbing; fixed in the next commit to keep diffs reviewable.
typecheck is intentionally broken at this commit."
```

---

## Task 4: Delete Slack routes + inbox + app.ts Slack plumbing

**Files:**
- Delete: `server/src/routes/messaging-slack.ts`
- Delete: `server/src/messaging/inbox.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/messaging/index.ts`
- Modify: `server/src/messaging/side-effects.ts`

- [ ] **Step 1: Delete the Slack route file**

```bash
rm server/src/routes/messaging-slack.ts
rm server/src/messaging/inbox.ts
```

- [ ] **Step 2: Update `server/src/app.ts` — strip Slack env detection + resolvers**

Find the block that reads `SLACK_APP_CLIENT_ID` / `SLACK_APP_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` and calls `defaultSlackResolvers`. Delete the `slack:` key from the `initMessaging` call. Delete the `slackEnvConfigured` variable. The block becomes:

```typescript
  // Public base URL for in-body link rewrites. Agents emit Slack-style
  // <path|label> with absolute Paperclip paths; any backend that speaks a
  // link format can use this host prefix.
  const publicBaseUrl =
    process.env.PAPERCLIP_PUBLIC_BASE_URL ||
    process.env.SLACK_OAUTH_REDIRECT_BASE_URL ||
    `http://${opts.bindHost}:${process.env.PAPERCLIP_LISTEN_PORT ?? 3100}`;
  initMessaging({
    db,
    storage: opts.storageService,
    issueUrlBase: publicBaseUrl,
    onMessageCreated: (args) => handleMessageCreatedSideEffects({ db }, args),
  });
```

Also delete the import `import { defaultSlackResolvers, initMessaging } ...` — change it to `import { initMessaging } from "./messaging/index.js";`. Delete the `handleMessageCreatedSideEffects` import stays. Delete any `mountSlackRoutes` / `messagingSlackRoutes` call.

- [ ] **Step 3: Update `server/src/messaging/index.ts` — drop Slack resolver exports**

Find and delete:
- The `defaultSlackResolvers` function
- The `streamToBuffer` helper (it was only used by Slack attachment ingest)
- The `resolveAttachmentBytes` function (also only Slack)
- Any re-exports related to Slack

Keep `initMessaging`, `resetMessagingForTests`, `isMessagingInitialized`, `resolveMessagingContext`, `requireMessagingContext`, `invalidateMessagingContext`, `getMessagingBootstrapDeps` exports.

- [ ] **Step 4: Update `server/src/messaging/side-effects.ts` — drop `dispatchInboxForMention` import + call**

Find the import `import { dispatchInboxForMention } from "./inbox.js";` — delete it.

Find the `for (const userId of args.mentionedUserIds)` loop inside `handleMessageCreatedSideEffects` and delete the whole loop. Inbox DMs are gone.

Also delete `mentionedUserIds` from the `MessageCreatedSideEffects` interface (and from all call sites that populate it).

- [ ] **Step 5: Find remaining callers of `dispatchInboxForMention`, etc. and delete them**

```bash
grep -rn "dispatchInboxFor\|dispatchInbox" server/src/ ui/src/ 2>&1 | head
```

Update any remaining call sites. `issuesService` had a few `dispatchInboxForAssignment` / `dispatchInboxForStatusChange` calls; delete those lines.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck 2>&1 | grep -E "error" | head
```

Expected: significantly fewer errors. Any remaining are likely test files still importing deleted modules — those get deleted in Task 5.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(messaging): delete Slack routes, inbox module, and app.ts plumbing

Removes:
- server/src/routes/messaging-slack.ts (OAuth + webhook endpoints)
- server/src/messaging/inbox.ts (per-user bot DM auto-discovery + dispatch)

app.ts drops SLACK_APP_* env detection and the inbox dispatch side
effect. The unified side-effect pipeline drops mentionedUserIds
entirely — no human-to-inbox DM concept exists post-migration.

Tests still reference deleted Slack modules and will be removed in
the next commit."
```

---

## Task 5: Delete Slack-adjacent tests + helper scripts

**Files:**
- Delete: Slack tests
- Delete: Slack helper scripts

- [ ] **Step 1: Delete Slack-specific test files**

```bash
rm server/src/__tests__/slack-oauth-routes.test.ts
rm server/src/__tests__/slack-events-webhook.test.ts
rm server/src/__tests__/slack-adapter-capabilities.test.ts
rm server/src/__tests__/slack-mention-parser.test.ts
rm server/src/__tests__/inbox-routes.test.ts
rm server/src/__tests__/inbox-service.test.ts
rm server/src/__tests__/messaging-thread-lock.test.ts
```

`messaging-thread-lock.test.ts` gets deleted because thread-lock as a concept is gone (Linear issues don't "lock threads").

- [ ] **Step 2: Delete Slack helper scripts**

```bash
rm server/scripts/slack-smoke.ts
rm server/scripts/plow-dev-bootstrap.ts
rm server/scripts/plow-dev-finish.ts
rm server/scripts/inspect-sam2-msgs.ts 2>/dev/null || true
rm server/scripts/wakeup-verify.ts 2>/dev/null || true
```

- [ ] **Step 3: Update `messaging-hardening.test.ts` — drop Slack-specific sub-tests**

Open `server/src/__tests__/messaging-hardening.test.ts`. Identify the sub-tests that reference Slack-specific invariants (workspace-scoped identity uniqueness, cross-channel `ts` collisions, ad-hoc channel quirks). Those are Slack-specific and should either be dropped now (Task 5 scope) or retargeted to Linear primitives later (Plan B).

For Plan A scope, DELETE the whole file:

```bash
rm server/src/__tests__/messaging-hardening.test.ts
```

(A new Linear-native hardening test suite is added in Plan B.)

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck 2>&1 | grep -E "error" | head
```

Expected: errors drop significantly. Remaining errors likely from `messaging-router.test.ts`, `messaging-events.test.ts`, `messaging-e2e-fake.test.ts`, `messaging-admin-status.test.ts`, `messaging-error-mapping.test.ts` — these need adaptation, done in Task 10.

- [ ] **Step 5: Run what tests DO compile**

```bash
pnpm -w test -- --run server/src/__tests__/issue-tracker-adapter-interface.test.ts server/src/__tests__/fake-adapter.test.ts 2>&1 | tail -5
```

Expected: those specific tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(messaging): delete Slack-adjacent tests and helper scripts

Removes:
- slack-oauth-routes.test.ts, slack-events-webhook.test.ts,
  slack-adapter-capabilities.test.ts, slack-mention-parser.test.ts
- inbox-routes.test.ts, inbox-service.test.ts
- messaging-thread-lock.test.ts (thread-lock concept gone)
- messaging-hardening.test.ts (Slack-specific; Linear-native version
  comes in Plan B)
- server/scripts/slack-smoke.ts, plow-dev-bootstrap.ts,
  plow-dev-finish.ts, inspect-sam2-msgs.ts, wakeup-verify.ts

Remaining messaging tests still compile but reference the old
MessagingAdapter interface; adapted in Task 10."
```

---

## Task 6: Add new schema files (issue_comment_refs, messaging_label_refs) + columns on issues/projects

**Files:**
- Create: `packages/db/src/schema/issue_comment_refs.ts`
- Create: `packages/db/src/schema/messaging_label_refs.ts`
- Modify: `packages/db/src/schema/issues.ts` (add `linear_issue_id`, `linear_issue_identifier`)
- Modify: `packages/db/src/schema/projects.ts` (add `linear_project_id`)
- Modify: `packages/db/src/schema/index.ts` (export new tables)

- [ ] **Step 1: Create `packages/db/src/schema/issue_comment_refs.ts`**

This is the same shape as the old `messaging_message_refs.ts` but FK to `issues` instead of `messaging_threads`.

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Pointer rows for issue comments that live in the external issue tracker
 * (Linear today; GitHub/Jira/etc. in the future). One row per external
 * comment. Body text lives in the external tracker — Paperclip never
 * stores it. The ref row carries orchestration metadata (run linkage,
 * wake suppression, edit/delete timestamps, reactions).
 *
 * Supersedes messaging_message_refs from the Slack-era schema.
 * Changes vs. predecessor:
 *   - FK is issueId -> issues.id (was threadId -> messaging_threads.id)
 *   - Uniqueness is (issueId, externalMessageRef) (was (backend, ...)
 *     then (threadId, ...) after Track 3)
 */
export const issueCommentRefs = pgTable(
  "issue_comment_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id),
    backend: text("backend").notNull(),
    externalMessageRef: text("external_message_ref").notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id").references(() => authUsers.id),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editCount: integer("edit_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    suppressedForWake: boolean("suppressed_for_wake").notNull().default(false),
    reactions: jsonb("reactions").$type<Record<string, string[]>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    issueRefUnique: uniqueIndex("issue_comment_refs_issue_ref_idx").on(
      table.issueId,
      table.externalMessageRef,
    ),
    issueFirstSeenIdx: index("issue_comment_refs_issue_seen_idx").on(
      table.issueId,
      table.firstSeenAt,
    ),
    runIdx: index("issue_comment_refs_run_idx").on(table.createdByRunId),
  }),
);
```

- [ ] **Step 2: Create `packages/db/src/schema/messaging_label_refs.ts`**

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { labels } from "./labels.js";

/**
 * Sync map between Paperclip's `labels` and external-tracker labels
 * (Linear today). One row per (paperclip label, backend) so label
 * changes in either direction resolve to the right counterpart.
 */
export const messagingLabelRefs = pgTable(
  "messaging_label_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    backend: text("backend").notNull(),
    paperclipLabelId: uuid("paperclip_label_id")
      .notNull()
      .references(() => labels.id),
    externalLabelRef: text("external_label_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    labelBackendUnique: uniqueIndex("messaging_label_refs_label_backend_idx").on(
      table.paperclipLabelId,
      table.backend,
    ),
    companyBackendRefUnique: uniqueIndex(
      "messaging_label_refs_company_backend_ref_idx",
    ).on(table.companyId, table.backend, table.externalLabelRef),
  }),
);
```

- [ ] **Step 3: Modify `packages/db/src/schema/issues.ts` — add `linear_issue_id` and `linear_issue_identifier`**

Find the `pgTable("issues", ...)` definition. Add two columns inside the columns object:

```typescript
    linearIssueId: uuid("linear_issue_id"),
    linearIssueIdentifier: text("linear_issue_identifier"),
```

Add a partial unique index in the constraint object (same file, the `(table) => ({ ... })` block):

```typescript
    linearIssueIdUnique: uniqueIndex("issues_linear_issue_id_idx")
      .on(table.linearIssueId)
      .where(sql`linear_issue_id IS NOT NULL`),
```

Import `sql` and `uniqueIndex` at the top of the file if not already imported.

- [ ] **Step 4: Modify `packages/db/src/schema/projects.ts` — add `linear_project_id`**

Same pattern:

```typescript
    linearProjectId: uuid("linear_project_id"),
```

And partial unique index:

```typescript
    linearProjectIdUnique: uniqueIndex("projects_linear_project_id_idx")
      .on(table.linearProjectId)
      .where(sql`linear_project_id IS NOT NULL`),
```

- [ ] **Step 5: Update `packages/db/src/schema/index.ts` — add exports for the new tables**

Add:

```typescript
export { issueCommentRefs } from "./issue_comment_refs.js";
export { messagingLabelRefs } from "./messaging_label_refs.js";
```

Keep the existing `messagingMessageRefs` / `messagingChannels` / `messagingThreads` exports for now — they get deleted in Task 7 so callers can still compile during the interim.

- [ ] **Step 6: Build the db package and generate the migration**

```bash
cd /Users/so/Hacking/paperclip
pnpm --filter @paperclipai/db build
pnpm db:generate
```

Expected: a new `packages/db/src/migrations/0061_*.sql` file containing CREATE TABLE for `issue_comment_refs`, CREATE TABLE for `messaging_label_refs`, ALTER TABLE issues, ALTER TABLE projects, CREATE INDEX commands.

- [ ] **Step 7: Inspect the generated migration**

```bash
cat packages/db/src/migrations/0061_*.sql
```

Expected: only ADD operations (no drops — old tables still referenced). If the file contains DROPs, the schema changes in this task are incomplete — investigate.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): add issue_comment_refs + messaging_label_refs + linear_issue_id

New schema additions for the Linear-backed issue tracker:
- issue_comment_refs: supersedes messaging_message_refs; FK to issues
- messaging_label_refs: sync map between Paperclip labels and Linear
  labels (and any future external-tracker label system)
- issues.linear_issue_id (nullable UUID, partial unique index)
- issues.linear_issue_identifier (nullable text, denormalized from
  Linear's identifier field for display)
- projects.linear_project_id (nullable UUID, partial unique index)

Old messaging_channels / messaging_threads / messaging_message_refs
tables still present for backwards compatibility during the refactor.
Dropped in the next commit."
```

---

## Task 7: Drop Slack-era schema + copy data forward

**Files:**
- Delete: `packages/db/src/schema/messaging_channels.ts`
- Delete: `packages/db/src/schema/messaging_threads.ts`
- Delete: `packages/db/src/schema/messaging_message_refs.ts`
- Modify: `packages/db/src/schema/index.ts` (remove exports)
- Modify: `packages/db/src/migrations/0061_*.sql` (add data copy + drops)

- [ ] **Step 1: Delete the Slack-era schema files**

```bash
rm packages/db/src/schema/messaging_channels.ts
rm packages/db/src/schema/messaging_threads.ts
rm packages/db/src/schema/messaging_message_refs.ts
```

- [ ] **Step 2: Remove the exports from `packages/db/src/schema/index.ts`**

Delete these lines:

```typescript
export { messagingChannels } from "./messaging_channels.js";
export { messagingThreads } from "./messaging_threads.js";
export { messagingMessageRefs } from "./messaging_message_refs.js";
```

- [ ] **Step 3: Regenerate the migration to pick up the table drops**

```bash
pnpm --filter @paperclipai/db build
pnpm db:generate
```

Expected: drizzle-kit updates `0061_*.sql` (or creates `0062_*.sql` if a new one is needed) with DROP TABLE statements for the three old tables.

- [ ] **Step 4: Inspect the migration**

```bash
ls -t packages/db/src/migrations/*.sql | head -2
cat packages/db/src/migrations/0061_*.sql packages/db/src/migrations/0062_*.sql 2>/dev/null | tail -60
```

Expected: CREATE statements for `issue_comment_refs`, `messaging_label_refs`, ALTER for `issues` + `projects`, followed by DROP statements for `messaging_channels`, `messaging_threads`, `messaging_message_refs`.

- [ ] **Step 5: Edit the migration to add data copy BEFORE the DROPs**

Between the CREATE statements and the DROP statements in the migration SQL, insert:

```sql
-- Copy rows from the Slack-era messaging_message_refs into issue_comment_refs.
-- Join through messaging_threads to resolve each ref's target issue_id.
INSERT INTO "issue_comment_refs" (
  id, issue_id, backend, external_message_ref,
  author_agent_id, author_user_id, created_by_run_id,
  first_seen_at, edited_at, edit_count, deleted_at,
  suppressed_for_wake, reactions, metadata
)
SELECT
  mmr.id, mt.issue_id, mmr.backend, mmr.external_message_ref,
  mmr.author_agent_id, mmr.author_user_id, mmr.created_by_run_id,
  mmr.first_seen_at, mmr.edited_at, mmr.edit_count, mmr.deleted_at,
  mmr.suppressed_for_wake, mmr.reactions, mmr.metadata
FROM "messaging_message_refs" mmr
JOIN "messaging_threads" mt ON mt.id = mmr.thread_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Retarget feedback_votes FK from messaging_message_refs to issue_comment_refs.
-- Safe: refs were copied preserving id.
ALTER TABLE "feedback_votes" DROP CONSTRAINT IF EXISTS "feedback_votes_target_ref_id_messaging_message_refs_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_target_ref_id_issue_comment_refs_id_fk"
  FOREIGN KEY ("target_ref_id") REFERENCES "issue_comment_refs"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Retarget issue_attachments FK (the messaging_message_ref_id column).
ALTER TABLE "issue_attachments" DROP CONSTRAINT IF EXISTS "issue_attachments_messaging_message_ref_id_messaging_message_refs_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_messaging_message_ref_id_issue_comment_refs_id_fk"
  FOREIGN KEY ("messaging_message_ref_id") REFERENCES "issue_comment_refs"("id") ON DELETE SET NULL;
--> statement-breakpoint
```

Paste this block BEFORE the `DROP TABLE` statements for `messaging_message_refs`, `messaging_threads`, `messaging_channels`. The order matters — refs must be copied and FKs retargeted before the old table is dropped.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck 2>&1 | grep error | head -20
```

Expected: errors throughout the server codebase referencing the deleted `messagingMessageRefs`, `messagingChannels`, `messagingThreads` symbols. These get fixed in Tasks 9 + 10. For now, proceed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): drop messaging_channels, messaging_threads, messaging_message_refs

Migration copies data from messaging_message_refs into issue_comment_refs
before dropping the old table, joining through messaging_threads to
resolve the target issue_id. feedback_votes and issue_attachments FKs
are retargeted to the new table.

After this commit, code references to the dropped tables break. The
next tasks rewrite the router / services / events processor to use
the new issue-centric schema."
```

---

## Task 8: Retarget feedback_votes and issue_attachments schema types

**Files:**
- Modify: `packages/db/src/schema/feedback_votes.ts` (rename column reference for FK target)
- Modify: `packages/db/src/schema/issue_attachments.ts` (rename column reference for FK target)

- [ ] **Step 1: Update `feedback_votes.ts` to reference `issueCommentRefs` instead of `messagingMessageRefs`**

Find the import:

```typescript
import { messagingMessageRefs } from "./messaging_message_refs.js";
```

Change to:

```typescript
import { issueCommentRefs } from "./issue_comment_refs.js";
```

Find the references inside the table definition (likely `references(() => messagingMessageRefs.id)` on the FK column). Change to `references(() => issueCommentRefs.id)`.

- [ ] **Step 2: Same update for `issue_attachments.ts`**

Find:

```typescript
import { messagingMessageRefs } from "./messaging_message_refs.js";
```

Change to:

```typescript
import { issueCommentRefs } from "./issue_comment_refs.js";
```

And update the `.references()` call on the `messagingMessageRefId` column.

- [ ] **Step 3: Build the db package**

```bash
pnpm --filter @paperclipai/db build 2>&1 | tail -5
```

Expected: clean build. If errors: some other file still imports the deleted modules.

- [ ] **Step 4: Run a `pnpm db:generate` to see if drizzle thinks any schema changed**

```bash
pnpm db:generate 2>&1 | tail -5
```

Expected: "No schema changes" (the FK change was already captured in the migration we wrote manually; drizzle just confirms the schema matches). If it generates a new migration, inspect it — should be empty or redundant.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(db): retarget feedback_votes + issue_attachments FKs to issue_comment_refs

Matches the FK retargeting in the migration at the type-level. No
new migration generated; drizzle schema matches migration state."
```

---

## Task 9: Redesign the `IssueTrackerAdapter` interface with issue-centric methods

Now we replace the Slack-shaped method set with the issue-centric one. This breaks compilation for every caller; we fix each in Task 10.

**Files:**
- Modify: `server/src/messaging/types.ts`

- [ ] **Step 1: Rewrite `server/src/messaging/types.ts`**

Replace the entire file with:

```typescript
export type BackendKey = "linear" | "fake";

export type MessageRefId = string;
export type ExternalRef = string;

export interface CapabilityFlags {
  supportsEditing: boolean;
  supportsReactions: boolean;
  supportsFileUpload: boolean;
  supportsIssueRelations: boolean;
  supportsLabels: boolean;
  requiresUserAuthPerIdentity: boolean;
}

export type AdapterCredential =
  | { kind: "bot_token"; secretId?: string }
  | { kind: "user_token"; secretId: string }
  | { kind: "none" };

export interface AuthorIdentity {
  backend: BackendKey;
  externalUserRef: ExternalRef;
  credential: AdapterCredential;
}

export interface AttachmentRef {
  paperclipAttachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export type AuthorKind = "agent" | "user" | "bot_system";

export interface CreateIssueArgs {
  externalTeamRef: ExternalRef;
  externalProjectRef?: ExternalRef | null;
  title: string;
  description?: string | null;
  assigneeExternalRef?: ExternalRef | null;
  stateExternalRef?: ExternalRef | null;
  priority?: number | null;
  labelExternalRefs?: ExternalRef[];
  author: AuthorIdentity;
}

export interface UpdateIssueArgs {
  externalIssueRef: ExternalRef;
  title?: string | null;
  description?: string | null;
  assigneeExternalRef?: ExternalRef | null;
  stateExternalRef?: ExternalRef | null;
  priority?: number | null;
  labelExternalRefs?: ExternalRef[];
  author: AuthorIdentity;
}

export interface IssueRef {
  externalIssueRef: ExternalRef;
  identifier: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Issue {
  externalIssueRef: ExternalRef;
  identifier: string;
  title: string;
  description: string | null;
  stateExternalRef: ExternalRef | null;
  priority: number | null;
  assigneeExternalRef: ExternalRef | null;
  labelExternalRefs: ExternalRef[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PostCommentArgs {
  externalIssueRef: ExternalRef;
  author: AuthorIdentity;
  body: string;
  attachments?: AttachmentRef[];
}

export interface CommentRef {
  externalCommentRef: ExternalRef;
  createdAt: Date;
}

export interface Comment {
  externalCommentRef: ExternalRef;
  externalIssueRef: ExternalRef;
  body: string;
  authorExternalRef: ExternalRef;
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
  reactions?: Record<string, string[]>;
}

export interface PaginationOpts {
  limit?: number;
  afterExternalRef?: ExternalRef;
}

export interface UploadAttachmentArgs {
  externalIssueRef: ExternalRef;
  externalCommentRef?: ExternalRef;
  by: AuthorIdentity;
  filename: string;
  contentType: string;
  body: Buffer;
}

export interface AttachmentUploadResult {
  externalAttachmentRef: ExternalRef | null;
}

export interface ProvisionAgentIdentityArgs {
  companyId: string;
  agentId: string;
  displayName: string;
  email?: string;
}

export type ProvisionResult =
  | { kind: "completed"; externalUserRef: ExternalRef; credential: AdapterCredential }
  | { kind: "needs_user_action"; redirectUrl: string; stateToken: string };

export type MessagingEvent =
  | {
      kind: "issue_created";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      identifier: string;
      assigneeExternalRef: ExternalRef | null;
      createdAt: Date;
    }
  | {
      kind: "issue_updated";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      changedFields: string[];
      assigneeExternalRef?: ExternalRef | null;
      stateExternalRef?: ExternalRef | null;
      updatedAt: Date;
    }
  | {
      kind: "issue_assignee_changed";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      newAssigneeExternalRef: ExternalRef | null;
      updatedAt: Date;
    }
  | {
      kind: "issue_removed";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      removedAt: Date;
    }
  | {
      kind: "comment_created";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      externalCommentRef: ExternalRef;
      authorExternalRef: ExternalRef;
      bodyRaw: string;
      mentionedExternalRefs: ExternalRef[];
      createdAt: Date;
    }
  | {
      kind: "comment_updated";
      externalEventId: string;
      externalCommentRef: ExternalRef;
      externalIssueRef: ExternalRef;
      bodyRaw: string;
      editedAt: Date;
    }
  | {
      kind: "comment_deleted";
      externalEventId: string;
      externalCommentRef: ExternalRef;
      externalIssueRef: ExternalRef;
      deletedAt: Date;
    }
  | {
      kind: "reaction_added" | "reaction_removed";
      externalEventId: string;
      externalCommentRef: ExternalRef;
      externalIssueRef: ExternalRef;
      reactorExternalRef: ExternalRef;
      emoji: string;
      at: Date;
    }
  | {
      kind: "labels_changed";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      addedExternalLabelRefs: ExternalRef[];
      removedExternalLabelRefs: ExternalRef[];
      updatedAt: Date;
    }
  | {
      kind: "attachment_changed";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      externalAttachmentRef: ExternalRef;
      action: "added" | "removed";
      updatedAt: Date;
    }
  | {
      kind: "project_changed";
      externalEventId: string;
      externalProjectRef: ExternalRef;
      action: "created" | "updated" | "removed";
      updatedAt: Date;
    };

export interface IssueTrackerAdapter {
  readonly backendKey: BackendKey;
  readonly capabilities: CapabilityFlags;

  createIssue(args: CreateIssueArgs): Promise<IssueRef>;
  updateIssue(args: UpdateIssueArgs): Promise<IssueRef>;
  getIssue(externalIssueRef: ExternalRef): Promise<Issue | null>;
  archiveIssue(externalIssueRef: ExternalRef): Promise<void>;

  postComment(args: PostCommentArgs): Promise<CommentRef>;
  editComment(externalCommentRef: ExternalRef, body: string): Promise<void>;
  deleteComment(externalCommentRef: ExternalRef, by: AuthorIdentity): Promise<void>;
  getComments(
    externalIssueRef: ExternalRef,
    opts?: PaginationOpts,
  ): Promise<Comment[]>;
  getComment(externalCommentRef: ExternalRef): Promise<Comment | null>;

  ensureLabel(
    companyId: string,
    name: string,
    color?: string | null,
  ): Promise<ExternalRef>;
  setIssueLabels(
    externalIssueRef: ExternalRef,
    externalLabelRefs: ExternalRef[],
  ): Promise<void>;

  uploadAttachment(args: UploadAttachmentArgs): Promise<AttachmentUploadResult>;

  provisionAgentIdentity(args: ProvisionAgentIdentityArgs): Promise<ProvisionResult>;
  resolveExternalUser(externalRef: ExternalRef): Promise<{
    displayName?: string;
    email?: string;
  } | null>;

  normalizeEvent(raw: unknown): MessagingEvent | null;
}

/**
 * Deprecated alias — will be removed once all call sites are migrated
 * away. Prefer `IssueTrackerAdapter`. Stays only as a transitional export
 * for one commit; removed in Task 10.
 */
export type MessagingAdapter = IssueTrackerAdapter;

export class MessagingBackendUnavailable extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "MessagingBackendUnavailable";
  }
}

export class MessagingIdentityNotActive extends Error {
  constructor(readonly identityId: string) {
    super(`messaging identity ${identityId} is not active`);
    this.name = "MessagingIdentityNotActive";
  }
}

export class MessagingNotConfigured extends Error {
  constructor(readonly companyId: string) {
    super(`messaging not configured for company ${companyId}`);
    this.name = "MessagingNotConfigured";
  }
}
```

Notice: `MessagingThreadLocked` is REMOVED. Any remaining import of it needs to go.

- [ ] **Step 2: Drop `MessagingThreadLocked` imports everywhere**

```bash
grep -rln "MessagingThreadLocked" server/src/ 2>&1
```

For each file, remove the import + any error-mapping that references it.

- [ ] **Step 3: Typecheck expectations**

```bash
pnpm typecheck 2>&1 | grep error | wc -l
```

Expected: many errors. The router, events, services, FakeAdapter, and several tests still reference old method names like `createChannel`, `createThread`, `postMessage`, `messagingMessageRefs`, etc. Task 10 fixes them.

- [ ] **Step 4: Commit — this IS an intermediate broken state**

```bash
git add -A
git commit -m "refactor(messaging): redesign IssueTrackerAdapter with issue-centric methods

New interface:
  createIssue / updateIssue / getIssue / archiveIssue
  postComment / editComment / deleteComment / getComments / getComment
  ensureLabel / setIssueLabels
  uploadAttachment
  provisionAgentIdentity / resolveExternalUser / normalizeEvent

Slack-inherited methods (createChannel, createThread, lockThread,
addChannelMember, postMessage, etc.) removed. MessagingThreadLocked
error class removed.

The remaining messaging code (router, events, services, FakeAdapter)
still references the old method names and won't compile. Task 10
rewrites those.

MessagingAdapter stays as a transitional type alias, removed at the
end of Task 10."
```

---

## Task 10: Refactor router, events, services, routes, FakeAdapter to the new interface

This is the largest task. Breaking it into sub-tasks aligned with files.

**Files:**
- Rewrite: `server/src/messaging/router.ts`
- Rewrite: `server/src/messaging/events.ts`
- Rewrite: `server/src/messaging/adapters/fake/adapter.ts`
- Modify: `server/src/messaging/context.ts`
- Modify: `server/src/messaging/side-effects.ts`
- Modify: `server/src/services/issues.ts`
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/feedback.ts`
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/routes/messaging-admin.ts`
- Modify: `server/src/__tests__/messaging-router.test.ts`
- Modify: `server/src/__tests__/messaging-events.test.ts`
- Modify: `server/src/__tests__/messaging-e2e-fake.test.ts`
- Modify: `server/src/__tests__/messaging-admin-status.test.ts`
- Modify: `server/src/__tests__/messaging-error-mapping.test.ts`
- Modify: `server/src/__tests__/helpers/messaging-test-seed.ts`
- Modify: `server/src/__tests__/fake-adapter.test.ts`

### 10a — FakeAdapter rewrite

- [ ] **Step 1: Replace `server/src/messaging/adapters/fake/adapter.ts`**

Rewrite the whole file as an in-memory `IssueTrackerAdapter`. Structure:

```typescript
import type {
  Comment,
  CommentRef,
  CreateIssueArgs,
  ExternalRef,
  Issue,
  IssueRef,
  IssueTrackerAdapter,
  MessagingEvent,
  PaginationOpts,
  PostCommentArgs,
  ProvisionAgentIdentityArgs,
  ProvisionResult,
  UpdateIssueArgs,
  UploadAttachmentArgs,
  AttachmentUploadResult,
  AuthorIdentity,
} from "../../types.js";

type LocalIssue = Issue & { counter: number };
type LocalComment = Comment;
type OnLocalEvent = (e: MessagingEvent) => void;

export interface FakeAdapterState {
  readonly issuesByRef: Map<ExternalRef, LocalIssue>;
  readonly commentsByRef: Map<ExternalRef, LocalComment>;
  readonly labelsByRef: Map<ExternalRef, { name: string; color: string | null }>;
}

export function createFakeAdapter(): IssueTrackerAdapter & {
  onLocalEvent: (cb: OnLocalEvent) => void;
  seedComment: (args: {
    ref: ExternalRef;
    externalIssueRef: ExternalRef;
    author: ExternalRef;
    body: string;
    createdAt?: Date;
  }) => void;
  state: FakeAdapterState;
} {
  const issuesByRef = new Map<ExternalRef, LocalIssue>();
  const commentsByRef = new Map<ExternalRef, LocalComment>();
  const labelsByRef = new Map<ExternalRef, { name: string; color: string | null }>();
  let counter = 0;
  let eventId = 0;
  const localListeners: OnLocalEvent[] = [];
  const emit = (e: MessagingEvent) => { for (const l of localListeners) l(e); };
  const nextEventId = () => `fake-evt-${++eventId}`;

  return {
    backendKey: "fake",
    capabilities: {
      supportsEditing: true,
      supportsReactions: true,
      supportsFileUpload: false,
      supportsIssueRelations: false,
      supportsLabels: true,
      requiresUserAuthPerIdentity: false,
    },

    async createIssue(args: CreateIssueArgs): Promise<IssueRef> {
      counter += 1;
      const ref = `I_${counter}`;
      const identifier = `FAKE-${counter}`;
      const now = new Date();
      const issue: LocalIssue = {
        externalIssueRef: ref,
        identifier,
        title: args.title,
        description: args.description ?? null,
        stateExternalRef: args.stateExternalRef ?? null,
        priority: args.priority ?? null,
        assigneeExternalRef: args.assigneeExternalRef ?? null,
        labelExternalRefs: args.labelExternalRefs ?? [],
        createdAt: now,
        updatedAt: now,
        counter,
      };
      issuesByRef.set(ref, issue);
      emit({
        kind: "issue_created",
        externalEventId: nextEventId(),
        externalIssueRef: ref,
        identifier,
        assigneeExternalRef: issue.assigneeExternalRef,
        createdAt: now,
      });
      return { externalIssueRef: ref, identifier, createdAt: now, updatedAt: now };
    },

    async updateIssue(args: UpdateIssueArgs): Promise<IssueRef> {
      const existing = issuesByRef.get(args.externalIssueRef);
      if (!existing) throw new Error(`fake adapter: issue ${args.externalIssueRef} not found`);
      const now = new Date();
      const changed: string[] = [];
      if (args.title !== undefined) { existing.title = args.title ?? ""; changed.push("title"); }
      if (args.description !== undefined) { existing.description = args.description; changed.push("description"); }
      if (args.assigneeExternalRef !== undefined) { existing.assigneeExternalRef = args.assigneeExternalRef; changed.push("assignee"); }
      if (args.stateExternalRef !== undefined) { existing.stateExternalRef = args.stateExternalRef; changed.push("state"); }
      if (args.priority !== undefined) { existing.priority = args.priority; changed.push("priority"); }
      if (args.labelExternalRefs !== undefined) { existing.labelExternalRefs = args.labelExternalRefs; changed.push("labels"); }
      existing.updatedAt = now;
      emit({
        kind: changed.includes("assignee") ? "issue_assignee_changed" : "issue_updated",
        externalEventId: nextEventId(),
        externalIssueRef: existing.externalIssueRef,
        changedFields: changed,
        assigneeExternalRef: existing.assigneeExternalRef,
        stateExternalRef: existing.stateExternalRef,
        newAssigneeExternalRef: existing.assigneeExternalRef,
        updatedAt: now,
      } as MessagingEvent);
      return {
        externalIssueRef: existing.externalIssueRef,
        identifier: existing.identifier,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
    },

    async getIssue(externalIssueRef: ExternalRef): Promise<Issue | null> {
      const found = issuesByRef.get(externalIssueRef);
      return found ? { ...found } : null;
    },

    async archiveIssue(externalIssueRef: ExternalRef): Promise<void> {
      issuesByRef.delete(externalIssueRef);
    },

    async postComment(args: PostCommentArgs): Promise<CommentRef> {
      counter += 1;
      const ref = `C_${counter}`;
      const now = new Date();
      commentsByRef.set(ref, {
        externalCommentRef: ref,
        externalIssueRef: args.externalIssueRef,
        body: args.body,
        authorExternalRef: args.author.externalUserRef,
        createdAt: now,
      });
      emit({
        kind: "comment_created",
        externalEventId: nextEventId(),
        externalIssueRef: args.externalIssueRef,
        externalCommentRef: ref,
        authorExternalRef: args.author.externalUserRef,
        bodyRaw: args.body,
        mentionedExternalRefs: [],
        createdAt: now,
      });
      return { externalCommentRef: ref, createdAt: now };
    },

    async editComment(externalCommentRef: ExternalRef, body: string): Promise<void> {
      const c = commentsByRef.get(externalCommentRef);
      if (!c) return;
      c.body = body;
      c.editedAt = new Date();
      emit({
        kind: "comment_updated",
        externalEventId: nextEventId(),
        externalCommentRef,
        externalIssueRef: c.externalIssueRef,
        bodyRaw: body,
        editedAt: c.editedAt,
      });
    },

    async deleteComment(externalCommentRef: ExternalRef, _by: AuthorIdentity): Promise<void> {
      const c = commentsByRef.get(externalCommentRef);
      if (!c) return;
      c.deletedAt = new Date();
      emit({
        kind: "comment_deleted",
        externalEventId: nextEventId(),
        externalCommentRef,
        externalIssueRef: c.externalIssueRef,
        deletedAt: c.deletedAt,
      });
    },

    async getComments(externalIssueRef: ExternalRef, _opts?: PaginationOpts): Promise<Comment[]> {
      return [...commentsByRef.values()]
        .filter((c) => c.externalIssueRef === externalIssueRef)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async getComment(externalCommentRef: ExternalRef): Promise<Comment | null> {
      return commentsByRef.get(externalCommentRef) ?? null;
    },

    async ensureLabel(companyId: string, name: string, color?: string | null): Promise<ExternalRef> {
      const existing = [...labelsByRef.entries()].find(([, l]) => l.name === name);
      if (existing) return existing[0];
      counter += 1;
      const ref = `L_${counter}`;
      labelsByRef.set(ref, { name, color: color ?? null });
      return ref;
    },

    async setIssueLabels(externalIssueRef: ExternalRef, externalLabelRefs: ExternalRef[]): Promise<void> {
      const issue = issuesByRef.get(externalIssueRef);
      if (!issue) return;
      const added = externalLabelRefs.filter((r) => !issue.labelExternalRefs.includes(r));
      const removed = issue.labelExternalRefs.filter((r) => !externalLabelRefs.includes(r));
      issue.labelExternalRefs = [...externalLabelRefs];
      emit({
        kind: "labels_changed",
        externalEventId: nextEventId(),
        externalIssueRef,
        addedExternalLabelRefs: added,
        removedExternalLabelRefs: removed,
        updatedAt: new Date(),
      });
    },

    async uploadAttachment(_args: UploadAttachmentArgs): Promise<AttachmentUploadResult> {
      return { externalAttachmentRef: null };
    },

    async provisionAgentIdentity(_args: ProvisionAgentIdentityArgs): Promise<ProvisionResult> {
      const ref = `U_fake_${Math.random().toString(36).slice(2, 8)}`;
      return {
        kind: "completed",
        externalUserRef: ref,
        credential: { kind: "none" },
      };
    },

    async resolveExternalUser(_externalRef: ExternalRef): Promise<{ displayName?: string; email?: string } | null> {
      return null;
    },

    normalizeEvent(_raw: unknown): MessagingEvent | null {
      return null;
    },

    // Extension for tests:
    onLocalEvent(cb: OnLocalEvent) {
      localListeners.push(cb);
    },
    seedComment(args: {
      ref: ExternalRef;
      externalIssueRef: ExternalRef;
      author: ExternalRef;
      body: string;
      createdAt?: Date;
    }) {
      commentsByRef.set(args.ref, {
        externalCommentRef: args.ref,
        externalIssueRef: args.externalIssueRef,
        body: args.body,
        authorExternalRef: args.author,
        createdAt: args.createdAt ?? new Date(),
      });
    },
    state: { issuesByRef, commentsByRef, labelsByRef },
  };
}
```

- [ ] **Step 2: Typecheck the FakeAdapter**

```bash
pnpm typecheck 2>&1 | grep -E "fake/adapter" | head
```

Expected: no errors pointing at `fake/adapter.ts`.

### 10b — Router rewrite

- [ ] **Step 3: Rewrite `server/src/messaging/router.ts` around the issue-centric adapter**

The router shape changes significantly. Its responsibilities are still:
- Resolve identity for the author (agent → user_token; user → user_token; else bot_system)
- Call the adapter's issue/comment methods
- Cache results into `issues` / `issue_comment_refs`

Full new `router.ts` (replace the file):

```typescript
import { and, eq, gt } from "drizzle-orm";
import type {
  AttachmentRef,
  AuthorIdentity,
  AuthorKind,
  BackendKey,
  ExternalRef,
  IssueTrackerAdapter,
} from "./types.js";
import { MessagingIdentityNotActive } from "./types.js";
import type { createDb } from "@paperclipai/db";
import {
  issues as issuesTable,
  issueCommentRefs,
  messagingIdentities,
} from "@paperclipai/db";

export type Db = ReturnType<typeof createDb>;

export interface RouterDeps {
  db: Db;
  adapter: IssueTrackerAdapter;
  backend: BackendKey;
  workspaceInstallId?: string | null;
  issueUrlBase?: string;
}

export interface RouterPostCommentArgs {
  companyId: string;
  issueId: string; // Paperclip internal uuid
  authorAgentId?: string;
  authorUserId?: string;
  authorKind?: AuthorKind;
  body: string;
  createdByRunId?: string;
  attachments?: AttachmentRef[];
}

export interface RouterCreateIssueArgs {
  companyId: string;
  title: string;
  description?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  projectId?: string | null;
  authorAgentId?: string;
  authorUserId?: string;
  authorKind?: AuthorKind;
  priority?: number;
  labelIds?: string[];
}

export interface RouterUpdateIssueArgs {
  companyId: string;
  issueId: string;
  title?: string | null;
  description?: string | null;
  assigneeAgentId?: string | null;
  status?: string | null;
  priority?: number | null;
  authorAgentId?: string;
  authorUserId?: string;
  authorKind?: AuthorKind;
}

export interface RouterReadComment {
  refId: string;
  externalCommentRef: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId: string | null;
  firstSeenAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  suppressedForWake: boolean;
}

export interface IssueTrackerRouter {
  backend: BackendKey;
  createIssue(args: RouterCreateIssueArgs): Promise<{ issueId: string; identifier: string }>;
  updateIssue(args: RouterUpdateIssueArgs): Promise<void>;
  postComment(args: RouterPostCommentArgs): Promise<{
    id: string;
    externalCommentRef: string;
    createdAt: Date;
  }>;
  editComment(args: { refId: string; body: string }): Promise<void>;
  deleteComment(args: { refId: string; by: AuthorIdentity }): Promise<void>;
  getComments(args: {
    issueId: string;
    afterRefId?: string;
  }): Promise<RouterReadComment[]>;
}

function buildCredential(row: { authBlobSecretId: string | null }) {
  if (row.authBlobSecretId) return { kind: "user_token" as const, secretId: row.authBlobSecretId };
  return { kind: "none" as const };
}

export function createIssueTrackerRouter(deps: RouterDeps): IssueTrackerRouter {
  const adapter = deps.adapter;
  const workspaceInstallId = deps.workspaceInstallId ?? null;

  async function loadIdentity(args: {
    companyId: string;
    agentId?: string;
    userId?: string;
  }) {
    const whereClauses = [
      eq(messagingIdentities.backend, deps.backend),
      eq(messagingIdentities.companyId, args.companyId),
    ];
    if (workspaceInstallId) {
      whereClauses.push(eq(messagingIdentities.workspaceInstallId, workspaceInstallId));
    }
    if (args.agentId) {
      whereClauses.push(eq(messagingIdentities.agentId, args.agentId));
    } else if (args.userId) {
      whereClauses.push(eq(messagingIdentities.userId, args.userId));
    } else {
      return undefined;
    }
    const [row] = await deps.db
      .select()
      .from(messagingIdentities)
      .where(and(...whereClauses))
      .limit(1);
    return row;
  }

  async function resolveAuthorIdentity(args: {
    companyId: string;
    agentId?: string;
    userId?: string;
    kindHint?: AuthorKind;
  }): Promise<AuthorIdentity> {
    const kind: AuthorKind =
      args.kindHint ?? (args.agentId ? "agent" : args.userId ? "user" : "bot_system");
    if (kind === "bot_system") {
      return {
        backend: deps.backend,
        externalUserRef: "SYSTEM",
        credential: deps.backend === "fake" ? { kind: "none" } : { kind: "bot_token" },
      };
    }
    const identity = await loadIdentity({
      companyId: args.companyId,
      agentId: args.agentId,
      userId: args.userId,
    });
    if (!identity) {
      return {
        backend: deps.backend,
        externalUserRef: "SYSTEM",
        credential: deps.backend === "fake" ? { kind: "none" } : { kind: "bot_token" },
      };
    }
    if (identity.state !== "active") {
      throw new MessagingIdentityNotActive(identity.id);
    }
    return {
      backend: deps.backend,
      externalUserRef: identity.externalUserRef,
      credential: buildCredential(identity),
    };
  }

  async function requireCachedIssue(issueId: string) {
    const [row] = await deps.db.select().from(issuesTable).where(eq(issuesTable.id, issueId)).limit(1);
    if (!row) throw new Error(`issue ${issueId} not found in cache`);
    if (!row.linearIssueId) {
      throw new Error(
        `issue ${issueId} has no linear_issue_id — cannot route to external tracker until it's created there`,
      );
    }
    return row;
  }

  const router: IssueTrackerRouter = {
    backend: deps.backend,

    async createIssue(args) {
      const author = await resolveAuthorIdentity({
        companyId: args.companyId,
        agentId: args.authorAgentId,
        userId: args.authorUserId,
        kindHint: args.authorKind,
      });
      // Resolve external team ref from workspace install metadata:
      // the team UUID is stamped there during app install (see Plan B).
      // For the fake adapter this argument is ignored.
      const result = await adapter.createIssue({
        externalTeamRef: "",
        title: args.title,
        description: args.description ?? null,
        // assignee/state/label resolution happens via adapter-specific layer
        // in Plan B; Plan A's router only surfaces raw references.
        assigneeExternalRef: null,
        stateExternalRef: null,
        priority: args.priority ?? null,
        labelExternalRefs: [],
        author,
      });
      // The adapter already returned the external refs. The caller at the
      // services/issues.ts layer inserts the issues row; this router does
      // not write to issues in Plan A (cache-sync wiring is Plan B).
      // For Plan A, services/issues.ts creates the row and fills
      // linear_issue_id from the adapter result.
      return { issueId: "", identifier: result.identifier };
    },

    async updateIssue(args) {
      const cached = await requireCachedIssue(args.issueId);
      const author = await resolveAuthorIdentity({
        companyId: args.companyId,
        agentId: args.authorAgentId,
        userId: args.authorUserId,
        kindHint: args.authorKind,
      });
      await adapter.updateIssue({
        externalIssueRef: cached.linearIssueId!,
        title: args.title ?? undefined,
        description: args.description ?? undefined,
        assigneeExternalRef: args.assigneeAgentId ? undefined : null,
        // status/priority mapping to external refs is deferred to Plan B
        stateExternalRef: undefined,
        priority: args.priority ?? undefined,
        author,
      });
    },

    async postComment(args) {
      const cached = await requireCachedIssue(args.issueId);
      const author = await resolveAuthorIdentity({
        companyId: args.companyId,
        agentId: args.authorAgentId,
        userId: args.authorUserId,
        kindHint: args.authorKind,
      });
      const posted = await adapter.postComment({
        externalIssueRef: cached.linearIssueId!,
        author,
        body: args.body,
        attachments: args.attachments,
      });
      const [inserted] = await deps.db
        .insert(issueCommentRefs)
        .values({
          issueId: args.issueId,
          backend: deps.backend,
          externalMessageRef: posted.externalCommentRef,
          authorAgentId: args.authorAgentId ?? null,
          authorUserId: args.authorUserId ?? null,
          createdByRunId: args.createdByRunId ?? null,
        })
        .onConflictDoUpdate({
          target: [issueCommentRefs.issueId, issueCommentRefs.externalMessageRef],
          set: {
            authorAgentId: args.authorAgentId ?? null,
            authorUserId: args.authorUserId ?? null,
            createdByRunId: args.createdByRunId ?? null,
          },
        })
        .returning();
      return {
        id: inserted!.id,
        externalCommentRef: inserted!.externalMessageRef,
        createdAt: posted.createdAt,
      };
    },

    async editComment(args) {
      const [ref] = await deps.db
        .select()
        .from(issueCommentRefs)
        .where(eq(issueCommentRefs.id, args.refId))
        .limit(1);
      if (!ref) return;
      await adapter.editComment(ref.externalMessageRef, args.body);
    },

    async deleteComment(args) {
      const [ref] = await deps.db
        .select()
        .from(issueCommentRefs)
        .where(eq(issueCommentRefs.id, args.refId))
        .limit(1);
      if (!ref) return;
      await adapter.deleteComment(ref.externalMessageRef, args.by);
    },

    async getComments({ issueId, afterRefId }) {
      let afterFirstSeen: Date | null = null;
      if (afterRefId) {
        const [cursor] = await deps.db
          .select({ firstSeenAt: issueCommentRefs.firstSeenAt })
          .from(issueCommentRefs)
          .where(eq(issueCommentRefs.id, afterRefId))
          .limit(1);
        if (cursor) afterFirstSeen = cursor.firstSeenAt;
      }
      const whereClauses = [eq(issueCommentRefs.issueId, issueId)];
      if (afterFirstSeen) whereClauses.push(gt(issueCommentRefs.firstSeenAt, afterFirstSeen));
      const refs = await deps.db
        .select()
        .from(issueCommentRefs)
        .where(and(...whereClauses))
        .orderBy(issueCommentRefs.firstSeenAt);

      // Fetch live bodies from adapter, zipped by externalMessageRef.
      const [cachedIssue] = await deps.db
        .select()
        .from(issuesTable)
        .where(eq(issuesTable.id, issueId))
        .limit(1);
      if (!cachedIssue || !cachedIssue.linearIssueId) {
        return refs
          .filter((r) => !r.deletedAt)
          .map((r) => ({
            refId: r.id,
            externalCommentRef: r.externalMessageRef,
            body: "",
            authorAgentId: r.authorAgentId,
            authorUserId: r.authorUserId,
            createdByRunId: r.createdByRunId,
            firstSeenAt: r.firstSeenAt,
            editedAt: r.editedAt,
            deletedAt: r.deletedAt,
            suppressedForWake: r.suppressedForWake,
          }));
      }
      const live = await adapter.getComments(cachedIssue.linearIssueId);
      const bodyByRef = new Map(live.map((c) => [c.externalCommentRef, c.body]));
      return refs
        .filter((r) => !r.deletedAt)
        .map((r) => ({
          refId: r.id,
          externalCommentRef: r.externalMessageRef,
          body: bodyByRef.get(r.externalMessageRef) ?? "",
          authorAgentId: r.authorAgentId,
          authorUserId: r.authorUserId,
          createdByRunId: r.createdByRunId,
          firstSeenAt: r.firstSeenAt,
          editedAt: r.editedAt,
          deletedAt: r.deletedAt,
          suppressedForWake: r.suppressedForWake,
        }));
    },
  };

  return router;
}

// Transitional alias for callers that still import `createMessagingRouter`.
// Removed at the end of Task 10.
export const createMessagingRouter = createIssueTrackerRouter;
export type MessagingRouter = IssueTrackerRouter;
```

Note: this router shape deliberately has `createIssue` stubbed — full issue-cache insertion happens in the `issuesService` layer (which has access to all the issue columns). Plan B adds the assignee/state/label external-ref resolution.

### 10c — Events processor rewrite

- [ ] **Step 4: Rewrite `server/src/messaging/events.ts`**

The events processor's role changes: lookups are now issue-centric, not channel/thread-centric. Replace with:

```typescript
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
          target: [messagingEventsInbox.backend, messagingEventsInbox.externalEventId],
        })
        .returning();
      if (inserted.length === 0) return;

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
          // Sync handlers land in Plan B's cache-sync module. For Plan A
          // we just dedup and noop.
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
  if (!row) return; // already existed
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
```

### 10d — Context, side-effects, services, routes

- [ ] **Step 5: Update `server/src/messaging/context.ts`**

Simplify `resolveMessagingContext` to only handle `fake` backend (Linear comes in Plan B). Replace the function body so that if `backend === 'fake'`, build the fake context as today; for anything else (`slack`, `linear`), return `{ status: 'disabled', companyId }`. (Plan B re-adds the Linear branch.)

- [ ] **Step 6: Update `server/src/messaging/side-effects.ts`**

Remove `dispatchInboxForMention` (already done in Task 4) and drop the `mentionedUserIds` parameter. Cross-reference the `EventsDeps.onMessageCreated` type signature we defined in step 4; they must match.

- [ ] **Step 7: Update `server/src/services/issues.ts`**

Find every reference to the router. The methods that were `router.postMessage`, `router.getThreadMessages`, `router.onIssueStateChange`, `router.setThreadLocked`, `router.uploadAttachmentToMessage` all need renaming:

| Old | New |
|---|---|
| `router.postMessage(...)` | `router.postComment(...)` |
| `router.getThreadMessages(...)` | `router.getComments(...)` |
| `router.onIssueStateChange(issueId)` | removed — no direct replacement; issue updates flow through `router.updateIssue`. The `onIssueStateChange` logic that edited the Slack thread parent is gone (Linear's issue card is Linear's own rendering). |
| `router.setThreadLocked(issueId, locked)` | removed — thread-lock concept gone. |
| `router.uploadAttachmentToMessage(...)` | removed from router; will be re-added as `router.uploadAttachment` in Plan B once the Linear attachment GraphQL op exists. |

Within `removeComment` (the cancel-comment flow), change the `deletedAt` logic to match the Track 5 spec: flip `suppressedForWake = true` rather than setting `deletedAt`. Plus replace `messagingMessageRefs` imports with `issueCommentRefs`.

Within `addComment`, call `ctx.router.postComment(...)`.

Within `getComments` / `getCommentCursor` / `getComment` / `listIssueCommentBodies`, replace `getThreadMessages` with `getComments` and rename the return-shape fields accordingly.

- [ ] **Step 8: Update `server/src/services/heartbeat.ts`**

Find all `messagingMessageRefs` imports — replace with `issueCommentRefs`. Inside the `getCommentBodiesForIssue` function (or whatever the helper is called), replace `router.getThreadMessages` with `router.getComments`.

- [ ] **Step 9: Update `server/src/services/feedback.ts`**

Same pattern: imports, query targets, and any `getThreadMessages` → `getComments`.

- [ ] **Step 10: Update `server/src/routes/issues.ts`**

Find the attachment-upload handler that calls `router.uploadAttachmentToMessage`. For Plan A, delete that call entirely (leave attachment creation intact but without the Linear upload; Plan B restores it properly). Add a comment:

```typescript
// TODO(plan-b): upload attachments to Linear via router.uploadAttachment()
// once the Linear adapter implements the attachmentCreate GraphQL mutation.
```

The `handleMessageCreatedSideEffects` call already uses `addComment`, which has been updated; the signature change (dropping `mentionedUserIds`) should match.

Remove the unused `resolveMessagingContext` import if the file no longer needs it.

- [ ] **Step 11: Update `server/src/routes/messaging-admin.ts`**

The `/messaging/diagnose/:issueId` endpoint joined through `messagingChannels` and `messagingThreads`. Rewrite it to join through `issueCommentRefs` directly from `issues`.

Drop the `messagingWorkspaceInstall` channel-level diagnose fields; keep the context block, the workspace install data, recent messages.

New shape of the diagnose response:

```typescript
{
  context: { status: 'disabled' | 'not_installed' | 'ready', backend?, workspaceInstallId? },
  issue: { id, identifier, title, status, linearIssueId, linearIssueIdentifier },
  recentComments: Array<{
    id, externalMessageRef, authorAgentId, authorUserId, createdByRunId,
    firstSeenAt, editedAt, editCount, deletedAt, suppressedForWake,
    sideEffectsDispatchedAt, cancelledAt,
  }>,
}
```

### 10e — Fix all remaining tests

- [ ] **Step 12: Update `server/src/__tests__/helpers/messaging-test-seed.ts`**

The seed helpers talked about `messagingChannels` / `messagingThreads` / `messagingMessageRefs` / `getMessagingRouter`. Rename references:

- `seedMessagingComment` → rename to `seedIssueComment`. Drop channel-and-thread provisioning (they don't exist). Just insert into `issueCommentRefs` directly keyed on `issues.id`.
- `postTestComment` → still goes through the router, but `ctx.router.postMessage(...)` → `ctx.router.postComment(...)`.
- `seedMessagingIdentity` stays as-is (identity schema unchanged).
- `clearMessagingFixtures` — drop `db.delete(messagingChannels)` / `db.delete(messagingThreads)` / `db.delete(messagingMessageRefs)`. Add `db.delete(issueCommentRefs)`.

- [ ] **Step 13: Update `server/src/__tests__/messaging-router.test.ts`**

Each test used `createMessagingRouter({ db, adapter, backend: 'fake' })`. Rename to `createIssueTrackerRouter`. Method calls change: `router.postMessage` → `router.postComment`, `router.getThreadMessages` → `router.getComments`, etc.

Many sub-tests relied on the channel/thread creation flow. These should be dropped or rewritten to test the issue/comment flow. Specifically:
- Drop `getOrCreateChannel is idempotent and slugs project names`
- Drop `getOrCreateThread posts an issue card once per issue`
- Drop `ensureChannelMember adds identity to channel members`
- Keep `postMessage stores a ref with createdByRunId preserved` → rewrite as `postComment stores a ref`
- Keep the `getThreadMessages returns refs zipped with live adapter bodies` → rewrite as `getComments returns refs zipped with live adapter bodies`
- Keep `postComment falls back to bot_system authoring when identity is missing` → rewrite

- [ ] **Step 14: Update `server/src/__tests__/messaging-events.test.ts`**

Same pattern. The events tests exercised `handleNewMessage`, `handleEdit`, `handleDelete`, `handleReaction`. Rewrite to exercise `handleCommentCreated`, `handleCommentUpdated`, `handleCommentDeleted`, `handleReaction` with the new event shapes.

Test setup needs to seed an `issues` row with a `linearIssueId` so the events processor can find it.

- [ ] **Step 15: Update `server/src/__tests__/messaging-e2e-fake.test.ts`**

The "full round-trip" test. Replace the channel/thread-centric flow with an issue/comment flow:
1. Seed a company + issue with `linear_issue_id` set
2. Create adapter + router
3. Post a comment through the router
4. Verify the adapter emits a `comment_created` local event
5. Events processor handles it → onMessageCreated fires
6. Edit, delete, reaction exercise the adapter and adjust the `issueCommentRefs` row accordingly

- [ ] **Step 16: Update `server/src/__tests__/messaging-admin-status.test.ts`**

The status endpoint still exists but now includes Linear-ish fields (initially empty since no Linear adapter exists in Plan A). Tests should verify `readiness: 'disabled'` for a company with no `active_backend`, and the shape of the response (workspaceInstallId, activeBackend, workspaceName are all null for disabled).

- [ ] **Step 17: Update `server/src/__tests__/messaging-error-mapping.test.ts`**

Drop the `MessagingThreadLocked` → 409 test case (error class removed). Keep the `MessagingIdentityNotActive`, `MessagingNotConfigured`, `MessagingBackendUnavailable` mappings.

- [ ] **Step 18: Update `server/src/__tests__/fake-adapter.test.ts`**

Test the new methods: `createIssue`, `updateIssue`, `getIssue`, `postComment`, `editComment`, `deleteComment`, `getComments`, `ensureLabel`, `setIssueLabels`.

### 10f — UI

- [ ] **Step 19: Update `ui/src/api/messaging.ts`**

Change the types to reflect "no Linear yet — readiness is always disabled or not-installed". Drop Slack-specific fields if present (workspaceRef, etc.). Keep the endpoint URL + readiness enum.

- [ ] **Step 20: Update `ui/src/pages/SettingsMessaging.tsx`**

The page referenced Slack-specific copy ("Connect Slack workspace", agent identity flows, inbox DM panels). Rewrite to be Linear-shaped: "Connect Linear workspace" button (disabled with a "Coming in Plan B" label for now), or just say "Messaging is disabled for this company".

The goal here is to make the page compile + render without Slack references. Plan B restores full functionality.

- [ ] **Step 21: Update `ui/src/pages/SettingsMessaging.test.tsx`**

Match the rewritten component.

### 10g — Final cleanup

- [ ] **Step 22: Remove transitional `MessagingAdapter` alias**

In `server/src/messaging/types.ts`, delete:

```typescript
export type MessagingAdapter = IssueTrackerAdapter;
```

And in `server/src/messaging/router.ts`, delete the alias exports at the bottom:

```typescript
export const createMessagingRouter = createIssueTrackerRouter;
export type MessagingRouter = IssueTrackerRouter;
```

Run typecheck again and rename any remaining import sites.

- [ ] **Step 23: Typecheck + test sweep**

```bash
pnpm typecheck 2>&1 | grep error | head
pnpm -w test -- --run server/ 2>&1 | tail -8
```

Expected: zero typecheck errors; all server tests pass.

- [ ] **Step 24: UI typecheck + test sweep**

```bash
pnpm -w test -- --run ui/ 2>&1 | tail -8
```

Expected: all UI tests pass.

- [ ] **Step 25: Commit the big one**

```bash
git add -A
git commit -m "refactor(messaging): rewrite router+events+services to IssueTrackerAdapter

Replaces the Slack-inherited channel/thread/message method set with
issue/comment primitives. Fake adapter reimplemented against the new
interface. Router exposes createIssue, updateIssue, postComment,
editComment, deleteComment, getComments. Events processor handles
comment_created/updated/deleted/reaction events against the new
issue_comment_refs table.

services/issues.ts:
  - addComment -> router.postComment
  - removeComment -> flips suppressedForWake (per Track 5 spec)
  - getComments/getCommentCursor/getComment -> router.getComments
  - onIssueStateChange, setThreadLocked calls removed (no Linear equivalent)
  - attachment upload to external tracker temporarily disabled
    (restored in Plan B)

services/heartbeat.ts + services/feedback.ts: joins updated to
issueCommentRefs.

messaging-admin diagnose endpoint: shape changed to issue-centric;
no more channel / thread blocks.

UI SettingsMessaging: disabled state is the only state in Plan A.
Plan B re-enables Linear install flow.

Tests: messaging-router/events/e2e-fake/admin-status/error-mapping
adapted to the new interface; helpers updated. Fake adapter tests
cover the new method surface.

MessagingAdapter alias removed; IssueTrackerAdapter is the only
interface name post this commit."
```

---

## Task 11: Stub Linear UI panel + final check

Just ensure the Settings page still makes sense visually when `readiness: 'disabled'` is the only possible state. Plan B re-implements the full install flow.

**Files:**
- Modify: `ui/src/pages/SettingsMessaging.tsx`

- [ ] **Step 1: Add a "Coming soon" banner where the install button used to be**

```tsx
<div className="space-y-3 rounded-md border border-border px-4 py-4">
  <p className="text-sm text-muted-foreground">
    Messaging is disabled for this company. Linear integration ships in Plan B
    of the migration.
  </p>
  <Button size="sm" disabled>
    <span className="mr-1.5">🔗</span>
    Connect Linear workspace (coming soon)
  </Button>
</div>
```

- [ ] **Step 2: Drop the agent-identities panel entirely from SettingsMessaging**

Until Plan B lands, there's nothing to show. Simplify the component to the single "disabled" state.

- [ ] **Step 3: Typecheck UI + test**

```bash
pnpm -w test -- --run ui/src/pages/SettingsMessaging.test.tsx 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ui): Settings Messaging shows 'coming soon' for Linear

Plan A leaves messaging fully disabled. Plan B re-implements the
Linear install + per-agent OAuth flow in this panel."
```

---

## Task 12: Final test sweep and branch verification

**Files:** none

- [ ] **Step 1: Full typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 2: Full server + ui test run**

```bash
pnpm -w test -- --run server/ ui/ 2>&1 | tail -10
```

Expected: all tests pass. Test count will be lower than before (we dropped ~6 Slack test files and retargeted ~8 others). Estimated final count: ~950–1000 tests passing.

- [ ] **Step 3: Verify no dangling Slack references**

```bash
grep -rin "slack" server/src/ ui/src/ packages/db/src/ 2>&1 | grep -v node_modules | grep -v dist | head -20
```

Expected: zero hits (or only hits inside the design spec docs, which are allowed).

- [ ] **Step 4: Verify no dangling `messaging_channels` / `messaging_threads` / `messaging_message_refs` references**

```bash
grep -rn "messagingChannels\|messagingThreads\|messagingMessageRefs" server/src/ packages/db/src/ 2>&1 | head
```

Expected: zero hits.

- [ ] **Step 5: Push the branch to the fork**

```bash
git push factory feat/linear-backend
```

- [ ] **Step 6: Commit the final verification note**

```bash
git log --oneline origin/feat/linear-backend..HEAD | head -15
```

Review the commit chain for readability — each commit should be a coherent step. No commit rewrite required.

---

## Definition of done for Plan A

- [ ] All 25+ steps in Tasks 1–12 complete
- [ ] `pnpm typecheck` clean
- [ ] `pnpm -w test -- --run server/ ui/` all green
- [ ] `grep -rin "slack" server/src/ ui/src/ packages/db/src/` returns zero hits
- [ ] `feat/linear-backend` pushed to fork, commits form a clean story
- [ ] `feat/slack-first-comms` untouched on fork
- [ ] Schema is issue-centric: `issues`, `issue_comment_refs`, `messaging_label_refs`, `messaging_identities`, `messaging_workspace_install`, `messaging_events_inbox`, `messaging_company_config` exist; `messaging_channels`, `messaging_threads`, `messaging_message_refs` are dropped
- [ ] `IssueTrackerAdapter` is the adapter interface; `FakeAdapter` conforms; no `MessagingAdapter` export remains
- [ ] The running Paperclip instance on wakeup can still boot (against the migrated DB) with `readiness: 'disabled'` for Sam's Plow Peeps
- [ ] Plan B can start fresh from this state

---

## Notes for the executor

**Order matters.** Don't skip ahead. The deletions in Tasks 3–5 introduce compile errors; the schema refactor in Tasks 6–8 depends on those deletions landing; the interface + service refactor in Tasks 9–10 depends on the schema being in place.

**Commit boundaries.** Each task is one commit (or two if the step count warrants splitting). Reviewers should be able to git-bisect and understand what each commit does in isolation.

**If you hit a genuine blocker** (e.g., a test that can't be adapted without a Linear adapter that doesn't yet exist), skip that test with `.skip` and file a follow-up in the commit message. Don't invent code in Plan A that belongs in Plan B.

**Don't set up Linear.** Plan A intentionally has zero Linear API calls. The OAuth app, workspace setup, webhook subscription all come in Plan B.

**When in doubt, consult the spec.** `docs/superpowers/specs/2026-04-19-linear-backend-migration-design.md` is the authority. If this plan and the spec conflict, the spec wins and the plan is wrong.
