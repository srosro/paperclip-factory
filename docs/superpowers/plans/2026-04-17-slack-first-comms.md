# Slack-first Comms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Paperclip's in-DB `issue_comments` with a pluggable `MessagingAdapter` system, shipping Slack as the built-in backend. Paperclip keeps orchestration metadata (run linkage, wake suppression, identities, threads, refs) and Slack holds message bodies, edits, deletes, reactions.

**Architecture:** New `server/src/messaging/` module with a backend-agnostic router and `events` processor, plus adapters (FakeAdapter for tests/dev; SlackAdapter for real use). Schema gains ref/identity/channel/thread/workspace tables; `issue_comments` is dropped; `issue_attachments` and `feedback_votes` FKs repoint to `messaging_message_refs`.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Vitest, Express (server), `@slack/web-api`, `@slack/bolt` (adapter only), React (UI).

**Spec:** `docs/superpowers/specs/2026-04-17-slack-first-comms-design.md`.

**Running tests:** `pnpm test` runs the whole monorepo; for a focused run use `pnpm --filter @paperclipai/server exec vitest run <path>` or `--filter @paperclipai/db`. Embedded-postgres integration tests gate themselves on `embeddedPostgresSupport.supported` so tests pass on machines without it.

**Commit style:** every commit footer ends with `Co-Authored-By: Paperclip <noreply@paperclip.ing>`. Keep commits small — typically one per task.

---

## Part 0 — Prep

### Task 0.1: Add Slack SDK dependency

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Add `@slack/web-api` to server deps**

Run: `pnpm --filter @paperclipai/server add @slack/web-api@^7`

- [ ] **Step 2: Verify install and typecheck**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add server/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(messaging): add @slack/web-api dependency

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 0.2: Create messaging module skeleton

**Files:**
- Create: `server/src/messaging/README.md`
- Create: `server/src/messaging/types.ts` (empty stub; filled in Task 2.1)
- Create: `server/src/messaging/adapters/fake/README.md`
- Create: `server/src/messaging/adapters/slack/README.md`

- [ ] **Step 1: Create module README**

Write `server/src/messaging/README.md`:

```md
# Messaging

Backend-agnostic comm layer for Paperclip. Slack is the built-in adapter; FakeAdapter backs tests and local dev. See `docs/superpowers/specs/2026-04-17-slack-first-comms-design.md`.

## Module rules

- `router.ts` is the only writer to `messaging_threads` and initial inserts to `messaging_message_refs`.
- `events.ts` is the only writer to `messaging_message_refs` edit/delete/reaction timestamps.
- Adapters never touch Paperclip's DB directly; they expose canonical operations and events.
```

- [ ] **Step 2: Create empty `types.ts`**

```ts
// Canonical messaging types — filled in Task 2.1
export {};
```

- [ ] **Step 3: Create adapter placeholder READMEs**

`server/src/messaging/adapters/fake/README.md`:

```md
# FakeAdapter

In-memory `MessagingAdapter` used by tests and local dev (`activeBackend='fake'`).
`postMessage` synchronously echoes an inbound event to `messaging/events.ts` so wake dispatch exercises the real pipeline.
```

`server/src/messaging/adapters/slack/README.md`:

```md
# Slack adapter

Implements `MessagingAdapter` against Slack. Uses one Slack app with bot scopes (workspace-level install) plus user scopes (per-agent install).
```

- [ ] **Step 4: Commit**

```bash
git add server/src/messaging
git commit -m "$(cat <<'EOF'
feat(messaging): scaffold module directory

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 1 — Schema

Each schema task creates one new Drizzle table file. The combined migration is generated in Task 1.9 so each file commits cleanly and reviewers can read one table at a time. All files use `.js` import suffixes per the existing project convention.

### Task 1.1: `messaging_workspace_install` schema

**Files:**
- Create: `packages/db/src/schema/messaging_workspace_install.ts`
- Modify: `packages/db/src/schema/index.ts` (export)

- [ ] **Step 1: Create schema file**

```ts
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { users } from "./auth.js";
import { companySecrets } from "./company_secrets.js";

export const messagingWorkspaceInstall = pgTable(
  "messaging_workspace_install",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    backend: text("backend").notNull(),
    externalWorkspaceRef: text("external_workspace_ref").notNull(),
    workspaceName: text("workspace_name"),
    botUserRef: text("bot_user_ref").notNull(),
    botTokenSecretId: uuid("bot_token_secret_id").notNull().references(() => companySecrets.id),
    signingSecretId: uuid("signing_secret_id").notNull().references(() => companySecrets.id),
    installedByUserId: uuid("installed_by_user_id").references(() => users.id),
    state: text("state").notNull().default("active"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBackendUnique: index("messaging_workspace_install_company_backend_idx").on(
      table.companyId,
      table.backend,
    ),
  }),
);
```

- [ ] **Step 2: Verify `auth.ts` exports `users`**

Run: `grep "export const users" packages/db/src/schema/auth.ts` — if no match, adjust the import in Step 1 to match the actual exporter.

- [ ] **Step 3: Export from schema index**

Append to `packages/db/src/schema/index.ts`:

```ts
export * from "./messaging_workspace_install.js";
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @paperclipai/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/messaging_workspace_install.ts packages/db/src/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(db): add messaging_workspace_install table

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 1.2: `messaging_channels` schema

**Files:**
- Create: `packages/db/src/schema/messaging_channels.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

```ts
import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { users } from "./auth.js";

export const messagingChannels = pgTable(
  "messaging_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    backend: text("backend").notNull(),
    purpose: text("purpose").notNull(),  // 'project' | 'inbox' | 'ad_hoc'
    projectId: uuid("project_id").references(() => projects.id),
    userId: uuid("user_id").references(() => users.id),
    externalChannelRef: text("external_channel_ref").notNull(),
    externalChannelName: text("external_channel_name"),
    state: text("state").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    backendRefUnique: uniqueIndex("messaging_channels_backend_ref_idx").on(
      table.backend,
      table.externalChannelRef,
    ),
    companyProjectUnique: uniqueIndex("messaging_channels_company_project_idx")
      .on(table.companyId, table.backend, table.projectId)
      .where(sql`purpose = 'project'`),
    companyInboxUnique: uniqueIndex("messaging_channels_company_inbox_idx")
      .on(table.companyId, table.backend, table.userId)
      .where(sql`purpose = 'inbox'`),
    purposeCheck: check(
      "messaging_channels_purpose_check",
      sql`(purpose = 'project' AND project_id IS NOT NULL)
          OR (purpose = 'inbox'   AND user_id    IS NOT NULL)
          OR (purpose = 'ad_hoc')`,
    ),
    stateIdx: index("messaging_channels_state_idx").on(table.companyId, table.state),
  }),
);
```

- [ ] **Step 2: Export from index**

Append to `packages/db/src/schema/index.ts`:
```ts
export * from "./messaging_channels.js";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @paperclipai/db typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/messaging_channels.ts packages/db/src/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(db): add messaging_channels table

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 1.3: `messaging_threads` schema

**Files:**
- Create: `packages/db/src/schema/messaging_threads.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

```ts
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { messagingChannels } from "./messaging_channels.js";

export const messagingThreads = pgTable(
  "messaging_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    channelId: uuid("channel_id").notNull().references(() => messagingChannels.id),
    backend: text("backend").notNull(),
    externalThreadRef: text("external_thread_ref").notNull(),
    parentMessageRef: text("parent_message_ref").notNull(),
    state: text("state").notNull().default("open"),  // 'open' | 'locked'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUnique: uniqueIndex("messaging_threads_issue_idx").on(table.issueId),
    channelIdx: index("messaging_threads_channel_idx").on(table.channelId),
  }),
);
```

- [ ] **Step 2: Export + typecheck + commit**

Append `export * from "./messaging_threads.js";` to `packages/db/src/schema/index.ts`.
Run: `pnpm --filter @paperclipai/db typecheck`

```bash
git add packages/db/src/schema/messaging_threads.ts packages/db/src/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(db): add messaging_threads table

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 1.4: `messaging_identities` schema

**Files:**
- Create: `packages/db/src/schema/messaging_identities.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

```ts
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { users } from "./auth.js";
import { companySecrets } from "./company_secrets.js";

export const messagingIdentities = pgTable(
  "messaging_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    userId: uuid("user_id").references(() => users.id),
    backend: text("backend").notNull(),
    externalUserRef: text("external_user_ref").notNull(),
    authBlobSecretId: uuid("auth_blob_secret_id").references(() => companySecrets.id),
    state: text("state").notNull().default("pending_auth"),  // 'active' | 'pending_auth' | 'revoked'
    inboxPreferences: jsonb("inbox_preferences").$type<Record<string, unknown>>(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    xorCheck: check(
      "messaging_identities_xor_check",
      sql`(agent_id IS NOT NULL) <> (user_id IS NOT NULL)`,
    ),
    backendUserUnique: uniqueIndex("messaging_identities_backend_user_idx").on(
      table.backend,
      table.externalUserRef,
    ),
    companyAgentUnique: uniqueIndex("messaging_identities_company_agent_idx")
      .on(table.companyId, table.backend, table.agentId)
      .where(sql`agent_id IS NOT NULL`),
    companyUserUnique: uniqueIndex("messaging_identities_company_user_idx")
      .on(table.companyId, table.backend, table.userId)
      .where(sql`user_id IS NOT NULL`),
  }),
);
```

- [ ] **Step 2: Export + typecheck + commit**

Append export. Typecheck.

```bash
git add packages/db/src/schema/messaging_identities.ts packages/db/src/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(db): add messaging_identities table

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 1.5: `messaging_message_refs` schema

**Files:**
- Create: `packages/db/src/schema/messaging_message_refs.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

```ts
import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { messagingThreads } from "./messaging_threads.js";
import { agents } from "./agents.js";
import { users } from "./auth.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const messagingMessageRefs = pgTable(
  "messaging_message_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => messagingThreads.id),
    backend: text("backend").notNull(),
    externalMessageRef: text("external_message_ref").notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: uuid("author_user_id").references(() => users.id),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editCount: integer("edit_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    suppressedForWake: boolean("suppressed_for_wake").notNull().default(false),
    reactions: jsonb("reactions").$type<Record<string, string[]>>(),  // emoji -> [externalUserRef]
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    backendRefUnique: uniqueIndex("messaging_message_refs_backend_ref_idx").on(
      table.backend,
      table.externalMessageRef,
    ),
    threadFirstSeenIdx: index("messaging_message_refs_thread_seen_idx").on(
      table.threadId,
      table.firstSeenAt,
    ),
    runIdx: index("messaging_message_refs_run_idx").on(table.createdByRunId),
  }),
);
```

- [ ] **Step 2: Export + typecheck + commit**

```bash
git add packages/db/src/schema/messaging_message_refs.ts packages/db/src/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(db): add messaging_message_refs table

Includes first-class orchestration columns: createdByRunId, editedAt,
editCount, deletedAt, suppressedForWake. Reactions held as jsonb map
of emoji to external user refs.

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 1.6: `messaging_events_inbox` schema

**Files:**
- Create: `packages/db/src/schema/messaging_events_inbox.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

```ts
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const messagingEventsInbox = pgTable(
  "messaging_events_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    backend: text("backend").notNull(),
    externalEventId: text("external_event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    backendEventUnique: uniqueIndex("messaging_events_inbox_backend_event_idx").on(
      table.backend,
      table.externalEventId,
    ),
    receivedIdx: index("messaging_events_inbox_received_idx").on(table.receivedAt),
  }),
);
```

- [ ] **Step 2: Export + typecheck + commit**

```bash
git add packages/db/src/schema/messaging_events_inbox.ts packages/db/src/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(db): add messaging_events_inbox table

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 1.7: `messaging_company_config` schema

**Files:**
- Create: `packages/db/src/schema/messaging_company_config.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

```ts
import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const messagingCompanyConfig = pgTable(
  "messaging_company_config",
  {
    companyId: uuid("company_id").primaryKey().references(() => companies.id),
    activeBackend: text("active_backend"),  // 'slack' | 'fake' | null
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
```

- [ ] **Step 2: Export + typecheck + commit**

```bash
git add packages/db/src/schema/messaging_company_config.ts packages/db/src/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(db): add messaging_company_config table

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 1.8: Repoint `issue_attachments` and `feedback_votes`; drop `issue_comments`

**Files:**
- Modify: `packages/db/src/schema/issue_attachments.ts`
- Modify: `packages/db/src/schema/feedback_votes.ts` (review shape first)
- Delete: `packages/db/src/schema/issue_comments.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Inspect feedback_votes shape**

Run: `cat packages/db/src/schema/feedback_votes.ts`

Identify the column that references `issue_comments.id` (likely `target_issue_comment_id`) and its type.

- [ ] **Step 2: Modify `issue_attachments.ts` — rename FK column**

Replace the `issueCommentId` column with:

```ts
messagingMessageRefId: uuid("messaging_message_ref_id").references(
  () => messagingMessageRefs.id,
  { onDelete: "set null" },
),
```

Update the import at the top: remove `issueComments`, add:

```ts
import { messagingMessageRefs } from "./messaging_message_refs.js";
```

- [ ] **Step 3: Modify `feedback_votes.ts` — repoint target FK**

Rename the existing comment-target column to `target_messaging_message_ref_id`, keep the same name semantics, repoint FK to `messagingMessageRefs.id` with `onDelete: "set null"`.

- [ ] **Step 4: Delete `issue_comments.ts`**

```bash
rm packages/db/src/schema/issue_comments.ts
```

- [ ] **Step 5: Remove the export from `index.ts`**

Delete the line `export * from "./issue_comments.js";` (or similar) from `packages/db/src/schema/index.ts`.

- [ ] **Step 6: Fix any direct importers of `issueComments`**

Run: `grep -rn "issueComments\|issue_comments" packages server/src ui/src 2>/dev/null`

For each import, replace with usage of the new types defined later (this will cause temporary breakage; accept it — the compile errors map the blast radius). Add a `TODO(messaging)` comment where the corresponding logic must be rewritten to call `messaging.router` in Part 6; for now, stub the function body to `throw new Error("issue_comments removed — wire messaging.router")` so type signatures still resolve.

- [ ] **Step 7: Typecheck expected to FAIL in services**

Run: `pnpm --filter @paperclipai/db typecheck`
Expected: PASS (db package is self-contained).

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: FAIL in `services/issues.ts`, `services/feedback.ts`, etc. This is intentional; Part 6 repairs these.

- [ ] **Step 8: Commit**

```bash
git add -A packages/db/src/schema server/src
git commit -m "$(cat <<'EOF'
refactor(db): drop issue_comments; repoint attachments + feedback_votes

- issue_attachments.issue_comment_id → messaging_message_ref_id
- feedback_votes target → messaging_message_refs.id
- Broken server services stubbed with TODO markers (rewired in Part 6)

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 1.9: Generate combined migration

**Files:**
- Create: `packages/db/src/migrations/<next-number>_<name>.sql` (auto-generated)
- Create: `packages/db/src/migrations/meta/<next-number>_snapshot.json` (auto-generated)

- [ ] **Step 1: Build the db package**

Run: `pnpm --filter @paperclipai/db build`
Expected: PASS.

- [ ] **Step 2: Generate migration**

Run: `pnpm db:generate`

Drizzle inspects compiled schema vs. the latest snapshot and writes a new `.sql` file under `packages/db/src/migrations/`.

- [ ] **Step 3: Inspect the generated migration**

Run: `ls packages/db/src/migrations | tail -2` to find the new file.

Open it and confirm:
- CREATE TABLE for each new messaging table
- ALTER TABLE issue_attachments DROP COLUMN issue_comment_id, ADD COLUMN messaging_message_ref_id ...
- ALTER TABLE feedback_votes similar
- DROP TABLE issue_comments

If any statement looks wrong, fix the schema file and regenerate (do not hand-edit the SQL).

- [ ] **Step 4: Run migration against a fresh dev DB**

Run: `pnpm db:migrate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations
git commit -m "$(cat <<'EOF'
feat(db): generate migration for messaging tables + issue_comments drop

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 2 — Types, interface, registry

### Task 2.1: Canonical messaging types

**Files:**
- Modify: `server/src/messaging/types.ts`

- [ ] **Step 1: Write the types file**

```ts
export type BackendKey = "slack" | "fake";

export type ChannelPurpose = "project" | "inbox" | "ad_hoc";

export type MessageRefId = string;      // UUID
export type ExternalRef = string;       // backend-specific opaque

export interface CapabilityFlags {
  supportsThreads: boolean;
  supportsEditing: boolean;
  supportsReactions: boolean;
  supportsButtons: boolean;
  supportsFileUpload: boolean;
  supportsThreadLock: boolean;
  requiresUserAuthPerIdentity: boolean;
}

export interface AuthorIdentity {
  backend: BackendKey;
  externalUserRef: ExternalRef;
  // Adapter-specific credential descriptor (e.g. {kind:'user_token', secretId})
  credential: AdapterCredential;
}

export type AdapterCredential =
  | { kind: "bot_token"; secretId: string }
  | { kind: "user_token"; secretId: string }
  | { kind: "none" };

export interface PostMessageArgs {
  channelRef: ExternalRef;
  threadRef?: ExternalRef;
  authorIdentity: AuthorIdentity;
  body: string;
  blocks?: unknown;           // backend-native structured content
  attachments?: AttachmentRef[];
}

export interface AttachmentRef {
  paperclipAttachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface CreateChannelArgs {
  name: string;
  purpose: ChannelPurpose;
  purposeText?: string;
  private?: boolean;
}

export interface CreateThreadArgs {
  channelRef: ExternalRef;
  parentBlocks: unknown;      // Block Kit payload for the issue card
  fallbackText: string;
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

export interface Message {
  refId: MessageRefId;
  externalMessageRef: ExternalRef;
  threadRef: ExternalRef;
  body: string;
  blocks?: unknown;
  authorExternalRef: ExternalRef;
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
  reactions?: Record<string, string[]>;
}

export type MessagingEvent =
  | {
      kind: "message";
      externalEventId: string;
      channelRef: ExternalRef;
      threadRef?: ExternalRef;
      messageRef: ExternalRef;
      authorExternalRef: ExternalRef;
      bodyRaw: string;
      createdAt: Date;
    }
  | {
      kind: "message_changed";
      externalEventId: string;
      messageRef: ExternalRef;
      channelRef: ExternalRef;
      bodyRaw: string;
      editedAt: Date;
    }
  | {
      kind: "message_deleted";
      externalEventId: string;
      messageRef: ExternalRef;
      channelRef: ExternalRef;
      deletedAt: Date;
    }
  | {
      kind: "reaction_added" | "reaction_removed";
      externalEventId: string;
      messageRef: ExternalRef;
      channelRef: ExternalRef;
      reactorExternalRef: ExternalRef;
      emoji: string;
      at: Date;
    };

export interface MessagingAdapter {
  readonly backendKey: BackendKey;
  readonly capabilities: CapabilityFlags;

  createChannel(args: CreateChannelArgs): Promise<{ externalRef: ExternalRef; name: string }>;
  archiveChannel(channelRef: ExternalRef): Promise<void>;
  addChannelMember(channelRef: ExternalRef, identityRef: ExternalRef): Promise<void>;
  removeChannelMember(channelRef: ExternalRef, identityRef: ExternalRef): Promise<void>;
  createThread(args: CreateThreadArgs): Promise<{ threadRef: ExternalRef; parentMessageRef: ExternalRef }>;
  lockThread(threadRef: ExternalRef): Promise<void>;

  postMessage(args: PostMessageArgs): Promise<{ messageRef: ExternalRef; createdAt: Date }>;
  editMessage(messageRef: ExternalRef, body: string, blocks?: unknown): Promise<void>;
  deleteMessage(messageRef: ExternalRef, by: AuthorIdentity): Promise<void>;
  getThreadMessages(threadRef: ExternalRef): Promise<Message[]>;
  getMessage(messageRef: ExternalRef): Promise<Message | null>;

  provisionAgentIdentity(args: ProvisionAgentIdentityArgs): Promise<ProvisionResult>;
  resolveExternalUser(externalRef: ExternalRef): Promise<{ displayName?: string; email?: string } | null>;

  normalizeEvent(raw: unknown): MessagingEvent | null;
}

export class MessagingBackendUnavailable extends Error {
  constructor(message: string, readonly code: string, readonly retryAfterSec?: number) {
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
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: PASS (types only).

- [ ] **Step 3: Commit**

```bash
git add server/src/messaging/types.ts
git commit -m "$(cat <<'EOF'
feat(messaging): define canonical types + adapter interface

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 2.2: Registry

**Files:**
- Create: `server/src/messaging/registry.ts`
- Create: `server/src/__tests__/messaging-registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createMessagingRegistry } from "../messaging/registry.js";
import type { MessagingAdapter } from "../messaging/types.js";

function stubAdapter(key: "slack" | "fake"): MessagingAdapter {
  return { backendKey: key } as unknown as MessagingAdapter;
}

describe("messaging registry", () => {
  it("registers and retrieves an adapter by key", () => {
    const registry = createMessagingRegistry();
    const fake = stubAdapter("fake");
    registry.register(fake);
    expect(registry.get("fake")).toBe(fake);
  });

  it("throws when retrieving an unknown backend", () => {
    const registry = createMessagingRegistry();
    expect(() => registry.require("slack")).toThrow(/no messaging adapter/i);
  });

  it("rejects duplicate registration of the same backend", () => {
    const registry = createMessagingRegistry();
    registry.register(stubAdapter("fake"));
    expect(() => registry.register(stubAdapter("fake"))).toThrow(/already registered/i);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/messaging-registry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement registry**

```ts
import type { BackendKey, MessagingAdapter } from "./types.js";

export interface MessagingRegistry {
  register(adapter: MessagingAdapter): void;
  get(key: BackendKey): MessagingAdapter | undefined;
  require(key: BackendKey): MessagingAdapter;
  list(): MessagingAdapter[];
}

export function createMessagingRegistry(): MessagingRegistry {
  const byKey = new Map<BackendKey, MessagingAdapter>();
  return {
    register(adapter) {
      if (byKey.has(adapter.backendKey)) {
        throw new Error(`messaging adapter '${adapter.backendKey}' already registered`);
      }
      byKey.set(adapter.backendKey, adapter);
    },
    get(key) {
      return byKey.get(key);
    },
    require(key) {
      const found = byKey.get(key);
      if (!found) throw new Error(`no messaging adapter registered for '${key}'`);
      return found;
    },
    list() {
      return [...byKey.values()];
    },
  };
}

// Process-wide singleton used by server startup.
export const messagingRegistry: MessagingRegistry = createMessagingRegistry();
```

- [ ] **Step 4: Run test to verify PASS**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/messaging-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/messaging/registry.ts server/src/__tests__/messaging-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(messaging): registry for adapter lookup

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 3 — FakeAdapter

The FakeAdapter is small but pivotal — it's how every later task exercises the router without hitting Slack. Keep it synchronous and deterministic.

### Task 3.1: FakeAdapter core

**Files:**
- Create: `server/src/messaging/adapters/fake/adapter.ts`
- Create: `server/src/__tests__/fake-adapter.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";

describe("FakeAdapter", () => {
  it("creates a channel and returns a unique external ref", async () => {
    const adapter = createFakeAdapter();
    const a = await adapter.createChannel({ name: "proj-a", purpose: "project" });
    const b = await adapter.createChannel({ name: "proj-b", purpose: "project" });
    expect(a.externalRef).not.toBe(b.externalRef);
  });

  it("posts a message and echoes it as a synchronous inbound event", async () => {
    const adapter = createFakeAdapter();
    const ch = await adapter.createChannel({ name: "proj-x", purpose: "project" });
    const th = await adapter.createThread({
      channelRef: ch.externalRef,
      parentBlocks: null,
      fallbackText: "issue card",
    });

    const echoed: unknown[] = [];
    adapter.onLocalEvent((e) => echoed.push(e));

    await adapter.postMessage({
      channelRef: ch.externalRef,
      threadRef: th.threadRef,
      authorIdentity: { backend: "fake", externalUserRef: "U_A", credential: { kind: "none" } },
      body: "hello",
    });

    expect(echoed).toHaveLength(1);
    expect(echoed[0]).toMatchObject({ kind: "message", bodyRaw: "hello", authorExternalRef: "U_A" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/fake-adapter.test.ts`

- [ ] **Step 3: Implement FakeAdapter**

```ts
import { randomUUID } from "node:crypto";
import type {
  MessagingAdapter,
  CapabilityFlags,
  CreateChannelArgs,
  CreateThreadArgs,
  PostMessageArgs,
  Message,
  MessagingEvent,
  AuthorIdentity,
  ExternalRef,
  ProvisionAgentIdentityArgs,
  ProvisionResult,
} from "../../types.js";

interface FakeChannel { ref: string; name: string; members: Set<string> }
interface FakeThread { ref: string; channelRef: string; parentRef: string; locked: boolean }
interface FakeMessage {
  ref: string;
  channelRef: string;
  threadRef?: string;
  author: string;
  body: string;
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
  reactions: Record<string, Set<string>>;
}

export interface FakeAdapter extends MessagingAdapter {
  onLocalEvent(listener: (e: MessagingEvent) => void): void;
  failNextPost(code: string): void;
  clear(): void;
}

const capabilities: CapabilityFlags = {
  supportsThreads: true,
  supportsEditing: true,
  supportsReactions: true,
  supportsButtons: false,
  supportsFileUpload: false,
  supportsThreadLock: true,
  requiresUserAuthPerIdentity: false,
};

export function createFakeAdapter(): FakeAdapter {
  const channels = new Map<string, FakeChannel>();
  const threads = new Map<string, FakeThread>();
  const messages = new Map<string, FakeMessage>();
  const listeners: Array<(e: MessagingEvent) => void> = [];
  let pendingFailure: string | null = null;

  function emit(e: MessagingEvent) {
    for (const l of listeners) l(e);
  }

  return {
    backendKey: "fake",
    capabilities,

    async createChannel(args: CreateChannelArgs) {
      const ref = `C_${randomUUID().slice(0, 8)}`;
      channels.set(ref, { ref, name: args.name, members: new Set() });
      return { externalRef: ref, name: args.name };
    },
    async archiveChannel(ref) {
      channels.delete(ref);
    },
    async addChannelMember(channelRef, identityRef) {
      channels.get(channelRef)?.members.add(identityRef);
    },
    async removeChannelMember(channelRef, identityRef) {
      channels.get(channelRef)?.members.delete(identityRef);
    },
    async createThread(args: CreateThreadArgs) {
      const parentRef = `M_${randomUUID().slice(0, 8)}`;
      const threadRef = parentRef;
      threads.set(threadRef, { ref: threadRef, channelRef: args.channelRef, parentRef, locked: false });
      messages.set(parentRef, {
        ref: parentRef,
        channelRef: args.channelRef,
        author: "BOT",
        body: args.fallbackText,
        createdAt: new Date(),
        reactions: {},
      });
      return { threadRef, parentMessageRef: parentRef };
    },
    async lockThread(ref) {
      const t = threads.get(ref);
      if (t) t.locked = true;
    },

    async postMessage(args: PostMessageArgs) {
      if (pendingFailure) {
        const code = pendingFailure;
        pendingFailure = null;
        throw new Error(`fake-fail:${code}`);
      }
      const ref = `M_${randomUUID().slice(0, 8)}`;
      const createdAt = new Date();
      messages.set(ref, {
        ref,
        channelRef: args.channelRef,
        threadRef: args.threadRef,
        author: args.authorIdentity.externalUserRef,
        body: args.body,
        createdAt,
        reactions: {},
      });
      emit({
        kind: "message",
        externalEventId: `E_${randomUUID().slice(0, 8)}`,
        channelRef: args.channelRef,
        threadRef: args.threadRef,
        messageRef: ref,
        authorExternalRef: args.authorIdentity.externalUserRef,
        bodyRaw: args.body,
        createdAt,
      });
      return { messageRef: ref, createdAt };
    },
    async editMessage(ref, body) {
      const m = messages.get(ref);
      if (!m) return;
      m.body = body;
      m.editedAt = new Date();
      emit({
        kind: "message_changed",
        externalEventId: `E_${randomUUID().slice(0, 8)}`,
        messageRef: ref,
        channelRef: m.channelRef,
        bodyRaw: body,
        editedAt: m.editedAt,
      });
    },
    async deleteMessage(ref, _by: AuthorIdentity) {
      const m = messages.get(ref);
      if (!m) return;
      m.deletedAt = new Date();
      emit({
        kind: "message_deleted",
        externalEventId: `E_${randomUUID().slice(0, 8)}`,
        messageRef: ref,
        channelRef: m.channelRef,
        deletedAt: m.deletedAt,
      });
    },
    async getThreadMessages(threadRef: ExternalRef) {
      const all: Message[] = [];
      for (const m of messages.values()) {
        if (m.threadRef === threadRef && !m.deletedAt) {
          all.push({
            refId: "",                 // filled by router; adapter doesn't know PaperclipIDs
            externalMessageRef: m.ref,
            threadRef,
            body: m.body,
            authorExternalRef: m.author,
            createdAt: m.createdAt,
            editedAt: m.editedAt,
            deletedAt: m.deletedAt,
            reactions: Object.fromEntries(
              Object.entries(m.reactions).map(([k, v]) => [k, [...v]]),
            ),
          });
        }
      }
      return all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async getMessage(ref) {
      const m = messages.get(ref);
      if (!m) return null;
      return {
        refId: "",
        externalMessageRef: m.ref,
        threadRef: m.threadRef ?? "",
        body: m.body,
        authorExternalRef: m.author,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        deletedAt: m.deletedAt,
      };
    },

    async provisionAgentIdentity(args: ProvisionAgentIdentityArgs): Promise<ProvisionResult> {
      return {
        kind: "completed",
        externalUserRef: `U_${args.agentId.slice(0, 8)}`,
        credential: { kind: "none" },
      };
    },
    async resolveExternalUser() {
      return null;
    },

    normalizeEvent(raw) {
      if (raw && typeof raw === "object" && "kind" in raw) return raw as MessagingEvent;
      return null;
    },

    onLocalEvent(listener) {
      listeners.push(listener);
    },
    failNextPost(code) {
      pendingFailure = code;
    },
    clear() {
      channels.clear();
      threads.clear();
      messages.clear();
      listeners.length = 0;
      pendingFailure = null;
    },
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/fake-adapter.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/messaging/adapters/fake/adapter.ts server/src/__tests__/fake-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(messaging): FakeAdapter with synchronous event echo

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 4 — Router

The router is the heart of the module. It orchestrates adapter calls, pointer-row writes, and integration with existing Paperclip services. This part should be built against the FakeAdapter so every task is hermetic.

### Task 4.1: Router scaffolding + getOrCreateChannel

**Files:**
- Create: `server/src/messaging/router.ts`
- Create: `server/src/__tests__/messaging-router-channel.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createMessagingRouter } from "../messaging/router.js";
import { createMessagingRegistry } from "../messaging/registry.js";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport }
  from "./helpers/embedded-postgres.js";
import { companies, projects, messagingChannels } from "@paperclipai/db";
import { eq } from "drizzle-orm";

const sup = await getEmbeddedPostgresTestSupport();
const describeIf = sup.supported ? describe : describe.skip;

describeIf("router.getOrCreateChannel", () => {
  it("lazily creates a channel for a project then returns the same row", async () => {
    const { db, cleanup } = await startEmbeddedPostgresTestDatabase();
    try {
      const [company] = await db.insert(companies).values({
        name: `Co ${randomUUID()}`,
        issuePrefix: "COX",
      }).returning();
      const [project] = await db.insert(projects).values({
        companyId: company!.id,
        name: "Plow",
        urlKey: "plow",
      }).returning();

      const adapter = createFakeAdapter();
      const registry = createMessagingRegistry();
      registry.register(adapter);
      const router = createMessagingRouter({ db, registry, backend: "fake" });

      const a = await router.getOrCreateChannel({ companyId: company!.id, projectId: project!.id });
      const b = await router.getOrCreateChannel({ companyId: company!.id, projectId: project!.id });

      expect(a.id).toBe(b.id);

      const rows = await db.select().from(messagingChannels).where(eq(messagingChannels.projectId, project!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.externalChannelName).toMatch(/^proj-/);
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement router skeleton**

```ts
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { messagingChannels, projects } from "@paperclipai/db";
import type { MessagingRegistry } from "./registry.js";
import type { BackendKey } from "./types.js";

export interface RouterDeps {
  db: Db;
  registry: MessagingRegistry;
  backend: BackendKey;
  channelNamePrefix?: string;
}

export interface MessagingRouter {
  getOrCreateChannel(args: { companyId: string; projectId: string }): Promise<{
    id: string;
    externalRef: string;
  }>;
}

export function createMessagingRouter(deps: RouterDeps): MessagingRouter {
  const prefix = deps.channelNamePrefix ?? "proj-";

  return {
    async getOrCreateChannel({ companyId, projectId }) {
      const existing = await deps.db
        .select()
        .from(messagingChannels)
        .where(
          and(
            eq(messagingChannels.companyId, companyId),
            eq(messagingChannels.backend, deps.backend),
            eq(messagingChannels.projectId, projectId),
          ),
        )
        .limit(1);
      if (existing[0]) return { id: existing[0].id, externalRef: existing[0].externalChannelRef };

      const project = await deps.db
        .select({ urlKey: projects.urlKey, name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!project[0]) throw new Error(`project ${projectId} not found`);

      const adapter = deps.registry.require(deps.backend);
      const name = normalizeChannelName(prefix + (project[0].urlKey ?? project[0].name));
      const created = await adapter.createChannel({ name, purpose: "project" });

      const [row] = await deps.db
        .insert(messagingChannels)
        .values({
          companyId,
          backend: deps.backend,
          purpose: "project",
          projectId,
          externalChannelRef: created.externalRef,
          externalChannelName: created.name,
        })
        .returning();
      return { id: row!.id, externalRef: row!.externalChannelRef };
    },
  };
}

export function normalizeChannelName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length ? cleaned : "proj";
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/messaging/router.ts server/src/__tests__/messaging-router-channel.test.ts
git commit -m "$(cat <<'EOF'
feat(messaging): router skeleton with getOrCreateChannel

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 4.2: Router.getOrCreateThread (posts issue card)

**Files:**
- Modify: `server/src/messaging/router.ts`
- Create: `server/src/messaging/issue-card.ts`
- Create: `server/src/__tests__/messaging-router-thread.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createMessagingRouter } from "../messaging/router.js";
import { createMessagingRegistry } from "../messaging/registry.js";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport }
  from "./helpers/embedded-postgres.js";
import { companies, projects, issues, messagingThreads } from "@paperclipai/db";
import { eq } from "drizzle-orm";

const sup = await getEmbeddedPostgresTestSupport();
const describeIf = sup.supported ? describe : describe.skip;

describeIf("router.getOrCreateThread", () => {
  it("posts an issue card, records the thread, and is idempotent per issue", async () => {
    const { db, cleanup } = await startEmbeddedPostgresTestDatabase();
    try {
      const [company] = await db.insert(companies).values({
        name: `Co ${randomUUID()}`, issuePrefix: "COX",
      }).returning();
      const [project] = await db.insert(projects).values({
        companyId: company!.id, name: "Plow", urlKey: "plow",
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId: company!.id,
        projectId: project!.id,
        title: "Fix login",
        identifier: "COX-1",
      }).returning();

      const adapter = createFakeAdapter();
      const registry = createMessagingRegistry();
      registry.register(adapter);
      const router = createMessagingRouter({ db, registry, backend: "fake" });

      const a = await router.getOrCreateThread({
        companyId: company!.id,
        issueId: issue!.id,
        projectId: project!.id,
      });
      const b = await router.getOrCreateThread({
        companyId: company!.id,
        issueId: issue!.id,
        projectId: project!.id,
      });
      expect(a.id).toBe(b.id);

      const rows = await db.select().from(messagingThreads).where(eq(messagingThreads.issueId, issue!.id));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Write issue-card builder**

`server/src/messaging/issue-card.ts`:

```ts
export interface IssueCardInput {
  identifier: string;
  title: string;
  status: string;
  assigneeDisplay?: string;
  priority?: string;
  projectName?: string;
  descriptionExcerpt?: string;
  issueUrl: string;
}

// Backend-agnostic fallback text — adapters render richer blocks when they can.
export function fallbackCardText(input: IssueCardInput): string {
  const lines = [
    `[${input.identifier}] ${input.title}`,
    [
      input.status,
      input.assigneeDisplay ? `assignee ${input.assigneeDisplay}` : null,
      input.priority ? `priority ${input.priority}` : null,
    ].filter(Boolean).join("  ·  "),
    input.projectName ? `project ${input.projectName}` : null,
    input.descriptionExcerpt ? `\n${input.descriptionExcerpt}` : null,
    `\n${input.issueUrl}`,
  ].filter(Boolean);
  return lines.join("\n");
}
```

- [ ] **Step 4: Extend router**

Add to `router.ts`:

```ts
import { issues as issuesTable, messagingThreads } from "@paperclipai/db";
import { fallbackCardText, type IssueCardInput } from "./issue-card.js";

// ... inside createMessagingRouter return object:

async getOrCreateThread({ companyId, issueId, projectId }: {
  companyId: string; issueId: string; projectId: string;
}) {
  const existing = await deps.db
    .select()
    .from(messagingThreads)
    .where(eq(messagingThreads.issueId, issueId))
    .limit(1);
  if (existing[0]) return { id: existing[0].id, threadRef: existing[0].externalThreadRef };

  const channel = await this.getOrCreateChannel({ companyId, projectId });
  const issueRow = await deps.db
    .select()
    .from(issuesTable)
    .where(eq(issuesTable.id, issueId))
    .limit(1);
  if (!issueRow[0]) throw new Error(`issue ${issueId} not found`);

  const cardInput: IssueCardInput = {
    identifier: issueRow[0].identifier ?? `${issueRow[0].id.slice(0, 8)}`,
    title: issueRow[0].title ?? "",
    status: issueRow[0].status ?? "",
    issueUrl: `/issues/${issueRow[0].id}`,
  };

  const adapter = deps.registry.require(deps.backend);
  const created = await adapter.createThread({
    channelRef: channel.externalRef,
    parentBlocks: null,
    fallbackText: fallbackCardText(cardInput),
  });

  const [row] = await deps.db
    .insert(messagingThreads)
    .values({
      issueId,
      channelId: channel.id,
      backend: deps.backend,
      externalThreadRef: created.threadRef,
      parentMessageRef: created.parentMessageRef,
    })
    .returning();
  return { id: row!.id, threadRef: row!.externalThreadRef };
},
```

Add `getOrCreateThread` to the `MessagingRouter` interface.

- [ ] **Step 5: Run — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add server/src/messaging/router.ts server/src/messaging/issue-card.ts \
  server/src/__tests__/messaging-router-thread.test.ts
git commit -m "$(cat <<'EOF'
feat(messaging): router.getOrCreateThread + issue card fallback

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 4.3: Router.postMessage

**Files:**
- Modify: `server/src/messaging/router.ts`
- Create: `server/src/__tests__/messaging-router-post.test.ts`

- [ ] **Step 1: Write failing test (identity required, run-id preserved, pointer row written)**

```ts
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createMessagingRouter } from "../messaging/router.js";
import { createMessagingRegistry } from "../messaging/registry.js";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport }
  from "./helpers/embedded-postgres.js";
import { companies, projects, issues, agents, messagingIdentities, messagingMessageRefs }
  from "@paperclipai/db";
import { eq } from "drizzle-orm";

const sup = await getEmbeddedPostgresTestSupport();
const describeIf = sup.supported ? describe : describe.skip;

describeIf("router.postMessage", () => {
  it("writes a message ref with createdByRunId set from the caller", async () => {
    const { db, cleanup } = await startEmbeddedPostgresTestDatabase();
    try {
      const [co] = await db.insert(companies).values({
        name: `Co ${randomUUID()}`, issuePrefix: "COP",
      }).returning();
      const [pj] = await db.insert(projects).values({
        companyId: co!.id, name: "P", urlKey: "p",
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId: co!.id, projectId: pj!.id, title: "t", identifier: "COP-1",
      }).returning();
      const [agent] = await db.insert(agents).values({
        companyId: co!.id, name: "alice",
      }).returning();
      await db.insert(messagingIdentities).values({
        companyId: co!.id,
        agentId: agent!.id,
        backend: "fake",
        externalUserRef: "U_alice",
        state: "active",
      });

      const adapter = createFakeAdapter();
      const registry = createMessagingRegistry();
      registry.register(adapter);
      const router = createMessagingRouter({ db, registry, backend: "fake" });

      const runId = randomUUID();
      const res = await router.postMessage({
        companyId: co!.id,
        issueId: issue!.id,
        projectId: pj!.id,
        authorAgentId: agent!.id,
        body: "hello",
        createdByRunId: runId,
      });

      const rows = await db.select().from(messagingMessageRefs).where(eq(messagingMessageRefs.id, res.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.createdByRunId).toBe(runId);
      expect(rows[0]!.authorAgentId).toBe(agent!.id);
    } finally {
      await cleanup();
    }
  });

  it("throws MessagingIdentityNotActive when the agent has no active identity", async () => {
    // ... similar setup without messagingIdentities insert; expect MessagingIdentityNotActive
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Extend router**

Append to `router.ts`:

```ts
import { messagingIdentities, messagingMessageRefs } from "@paperclipai/db";
import { MessagingIdentityNotActive } from "./types.js";

// ... in interface:
postMessage(args: {
  companyId: string;
  issueId: string;
  projectId: string;
  authorAgentId?: string;
  authorUserId?: string;
  body: string;
  createdByRunId?: string;
}): Promise<{ id: string; externalMessageRef: string; createdAt: Date }>;

// ... inside return object:
async postMessage(args) {
  const thread = await this.getOrCreateThread({
    companyId: args.companyId,
    issueId: args.issueId,
    projectId: args.projectId,
  });

  let authorIdentityRow: typeof messagingIdentities.$inferSelect | undefined;
  if (args.authorAgentId) {
    const rows = await deps.db
      .select()
      .from(messagingIdentities)
      .where(
        and(
          eq(messagingIdentities.backend, deps.backend),
          eq(messagingIdentities.agentId, args.authorAgentId),
        ),
      )
      .limit(1);
    authorIdentityRow = rows[0];
  } else if (args.authorUserId) {
    const rows = await deps.db
      .select()
      .from(messagingIdentities)
      .where(
        and(
          eq(messagingIdentities.backend, deps.backend),
          eq(messagingIdentities.userId, args.authorUserId),
        ),
      )
      .limit(1);
    authorIdentityRow = rows[0];
  }
  if (!authorIdentityRow || authorIdentityRow.state !== "active") {
    throw new MessagingIdentityNotActive(authorIdentityRow?.id ?? "none");
  }

  const channelRow = await deps.db
    .select()
    .from(messagingChannels)
    .where(eq(messagingChannels.id, /* from thread join — fetch separately */ thread.id))
    .limit(1);
  // Fetch channel via thread row for correctness:
  const [threadRow] = await deps.db
    .select()
    .from(messagingThreads)
    .where(eq(messagingThreads.id, thread.id))
    .limit(1);
  const [chRow] = await deps.db
    .select()
    .from(messagingChannels)
    .where(eq(messagingChannels.id, threadRow!.channelId))
    .limit(1);

  const adapter = deps.registry.require(deps.backend);
  const posted = await adapter.postMessage({
    channelRef: chRow!.externalChannelRef,
    threadRef: threadRow!.externalThreadRef,
    authorIdentity: {
      backend: deps.backend,
      externalUserRef: authorIdentityRow.externalUserRef,
      credential: buildCredentialForIdentity(authorIdentityRow),
    },
    body: args.body,
  });

  const [inserted] = await deps.db
    .insert(messagingMessageRefs)
    .values({
      threadId: threadRow!.id,
      backend: deps.backend,
      externalMessageRef: posted.messageRef,
      authorAgentId: args.authorAgentId ?? null,
      authorUserId: args.authorUserId ?? null,
      createdByRunId: args.createdByRunId ?? null,
    })
    .onConflictDoUpdate({
      target: [messagingMessageRefs.backend, messagingMessageRefs.externalMessageRef],
      set: { createdByRunId: args.createdByRunId ?? null },
    })
    .returning();
  return { id: inserted!.id, externalMessageRef: inserted!.externalMessageRef, createdAt: posted.createdAt };
},
```

Add helper:

```ts
function buildCredentialForIdentity(row: typeof messagingIdentities.$inferSelect) {
  if (row.authBlobSecretId) return { kind: "user_token" as const, secretId: row.authBlobSecretId };
  return { kind: "none" as const };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/messaging/router.ts server/src/__tests__/messaging-router-post.test.ts
git commit -m "$(cat <<'EOF'
feat(messaging): router.postMessage with identity lookup and run linkage

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 4.4: Router.getThreadMessages (refs + live body fetch)

**Files:**
- Modify: `server/src/messaging/router.ts`
- Create: `server/src/__tests__/messaging-router-read.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Similar setup: post two messages via router, then call router.getThreadMessages.
// Assert bodies come back in order, from adapter (not DB).
// To prove it reads live: after posting, mutate the FakeAdapter's stored body
// for one of the refs via adapter.editMessage — expect the edited body in the list.
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
getThreadMessages(args: { issueId: string; afterRefId?: string }): Promise<Array<{
  refId: string;
  externalMessageRef: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}>>;

// impl:
async getThreadMessages({ issueId, afterRefId }) {
  const [threadRow] = await deps.db
    .select()
    .from(messagingThreads)
    .where(eq(messagingThreads.issueId, issueId))
    .limit(1);
  if (!threadRow) return [];

  const refs = await deps.db
    .select()
    .from(messagingMessageRefs)
    .where(
      and(
        eq(messagingMessageRefs.threadId, threadRow.id),
        // afterRefId filtering: look up firstSeenAt of afterRefId and filter greater
      ),
    )
    .orderBy(messagingMessageRefs.firstSeenAt);

  const adapter = deps.registry.require(deps.backend);
  const liveMessages = await adapter.getThreadMessages(threadRow.externalThreadRef);
  const byRef = new Map(liveMessages.map((m) => [m.externalMessageRef, m]));

  return refs
    .filter((r) => !r.deletedAt)
    .map((r) => {
      const live = byRef.get(r.externalMessageRef);
      return {
        refId: r.id,
        externalMessageRef: r.externalMessageRef,
        body: live?.body ?? "",
        authorAgentId: r.authorAgentId,
        authorUserId: r.authorUserId,
        createdAt: r.firstSeenAt,
        editedAt: r.editedAt,
        deletedAt: r.deletedAt,
      };
    });
},
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/messaging/router.ts server/src/__tests__/messaging-router-read.test.ts
git commit -m "$(cat <<'EOF'
feat(messaging): router.getThreadMessages — refs + live body fetch

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 4.5: Router.onIssueStateChange (edits thread parent)

**Files:**
- Modify: `server/src/messaging/router.ts`
- Create: `server/src/__tests__/messaging-router-card-update.test.ts`

- [ ] **Step 1: Write failing test**

Post an issue, create the thread, change the issue's status via DB, call `router.onIssueStateChange`, then verify `adapter.getMessage(parentRef).body` reflects the new status line.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
onIssueStateChange(issueId: string): Promise<void>;

async onIssueStateChange(issueId) {
  const [t] = await deps.db
    .select()
    .from(messagingThreads)
    .where(eq(messagingThreads.issueId, issueId))
    .limit(1);
  if (!t) return;   // no thread yet; fire-and-forget is fine

  const [issue] = await deps.db
    .select()
    .from(issuesTable)
    .where(eq(issuesTable.id, issueId))
    .limit(1);
  if (!issue) return;

  const cardInput: IssueCardInput = {
    identifier: issue.identifier ?? issue.id.slice(0, 8),
    title: issue.title ?? "",
    status: issue.status ?? "",
    issueUrl: `/issues/${issue.id}`,
  };

  const adapter = deps.registry.require(deps.backend);
  try {
    await adapter.editMessage(t.parentMessageRef, fallbackCardText(cardInput));
  } catch (err) {
    // Non-fatal; log and continue
    console.warn(`issue card edit failed for ${issueId}`, err);
  }
},
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/messaging/router.ts server/src/__tests__/messaging-router-card-update.test.ts
git commit -m "$(cat <<'EOF'
feat(messaging): router.onIssueStateChange edits thread parent

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 4.6: Channel membership management

**Files:**
- Modify: `server/src/messaging/router.ts`
- Create: `server/src/__tests__/messaging-router-membership.test.ts`

- [ ] **Step 1: Write failing test**

Given an issue assignment, the router should `addChannelMember` for the assignee's identity external ref and no-op on subsequent identical calls.

- [ ] **Step 2: Implement**

```ts
ensureChannelMember(args: { companyId: string; projectId: string; agentId?: string; userId?: string }): Promise<void>;

async ensureChannelMember({ companyId, projectId, agentId, userId }) {
  const channel = await this.getOrCreateChannel({ companyId, projectId });
  // find identity
  const where = agentId
    ? and(eq(messagingIdentities.backend, deps.backend), eq(messagingIdentities.agentId, agentId))
    : and(eq(messagingIdentities.backend, deps.backend), eq(messagingIdentities.userId, userId!));
  const [identity] = await deps.db.select().from(messagingIdentities).where(where!).limit(1);
  if (!identity || identity.state !== "active") return;
  const adapter = deps.registry.require(deps.backend);
  await adapter.addChannelMember(channel.externalRef, identity.externalUserRef);
},
```

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): router.ensureChannelMember

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 5 — Inbound events

### Task 5.1: Events module scaffolding + dedup

**Files:**
- Create: `server/src/messaging/events.ts`
- Create: `server/src/__tests__/messaging-events-dedup.test.ts`

- [ ] **Step 1: Write failing test**

Same `externalEventId` submitted twice → second call short-circuits without side-effects.

- [ ] **Step 2: Implement**

```ts
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  messagingEventsInbox, messagingMessageRefs, messagingThreads,
  messagingChannels, messagingIdentities,
} from "@paperclipai/db";
import type { MessagingEvent, BackendKey } from "./types.js";

export interface EventsDeps {
  db: Db;
  backend: BackendKey;
  onMessageCreated?: (refId: string, companyId: string, issueId: string) => Promise<void>;
}

export interface EventsProcessor {
  handle(event: MessagingEvent): Promise<void>;
}

export function createEventsProcessor(deps: EventsDeps): EventsProcessor {
  return {
    async handle(event) {
      // dedup
      const inserted = await deps.db
        .insert(messagingEventsInbox)
        .values({ backend: deps.backend, externalEventId: event.externalEventId })
        .onConflictDoNothing({
          target: [messagingEventsInbox.backend, messagingEventsInbox.externalEventId],
        })
        .returning();
      if (inserted.length === 0) return;   // duplicate; already processed

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

// Placeholder handlers — fleshed out in subsequent tasks
async function handleNewMessage(_deps: EventsDeps, _e: MessagingEvent) {}
async function handleEdit(_deps: EventsDeps, _e: MessagingEvent) {}
async function handleDelete(_deps: EventsDeps, _e: MessagingEvent) {}
async function handleReaction(_deps: EventsDeps, _e: MessagingEvent) {}
```

- [ ] **Step 3–5: Run test, PASS, commit.**

```bash
git add server/src/messaging/events.ts server/src/__tests__/messaging-events-dedup.test.ts
git commit -m "$(cat <<'EOF'
feat(messaging): events dedup via messaging_events_inbox

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 5.2: Event handler — new message upsert + wake dispatch

**Files:**
- Modify: `server/src/messaging/events.ts`
- Create: `server/src/__tests__/messaging-events-new.test.ts`

- [ ] **Step 1: Test**

When a `message` event arrives for a known thread, a `messaging_message_refs` row exists and `onMessageCreated` is called with the new ref id.

- [ ] **Step 2: Implement `handleNewMessage`**

```ts
async function handleNewMessage(deps: EventsDeps, e: Extract<MessagingEvent, { kind: "message" }>) {
  // resolve channel
  const [ch] = await deps.db.select().from(messagingChannels)
    .where(and(
      eq(messagingChannels.backend, deps.backend),
      eq(messagingChannels.externalChannelRef, e.channelRef),
    )).limit(1);
  if (!ch) return;   // not a Paperclip-managed channel

  // resolve thread
  const threadRef = e.threadRef ?? e.messageRef; // if no thread_ts, the message is the parent
  const [th] = await deps.db.select().from(messagingThreads)
    .where(and(
      eq(messagingThreads.backend, deps.backend),
      eq(messagingThreads.externalThreadRef, threadRef),
    )).limit(1);
  if (!th) return;   // top-level message in a project channel — ignore

  // resolve author
  const [ident] = await deps.db.select().from(messagingIdentities)
    .where(and(
      eq(messagingIdentities.backend, deps.backend),
      eq(messagingIdentities.externalUserRef, e.authorExternalRef),
    )).limit(1);

  const [row] = await deps.db
    .insert(messagingMessageRefs)
    .values({
      threadId: th.id,
      backend: deps.backend,
      externalMessageRef: e.messageRef,
      authorAgentId: ident?.agentId ?? null,
      authorUserId: ident?.userId ?? null,
      firstSeenAt: e.createdAt,
    })
    .onConflictDoNothing({
      target: [messagingMessageRefs.backend, messagingMessageRefs.externalMessageRef],
    })
    .returning();
  if (!row) return;   // already upserted by a previous path (agent write)
  if (deps.onMessageCreated) {
    await deps.onMessageCreated(row.id, ch.companyId, th.issueId);
  }
}
```

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): handle inbound new-message events

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 5.3: Event handlers — edit, delete, reaction

**Files:**
- Modify: `server/src/messaging/events.ts`
- Create: `server/src/__tests__/messaging-events-edit-delete.test.ts`

- [ ] **Step 1: Test each variant**

```ts
// After seeding a ref, fire message_changed → editedAt set, editCount incremented
// Fire message_deleted → deletedAt set
// Fire reaction_added → reactions.<emoji> contains reactor ref
// Fire reaction_removed → reactor removed
```

- [ ] **Step 2: Implement**

```ts
async function handleEdit(deps: EventsDeps, e: Extract<MessagingEvent, { kind: "message_changed" }>) {
  await deps.db
    .update(messagingMessageRefs)
    .set({
      editedAt: e.editedAt,
      editCount: sql`${messagingMessageRefs.editCount} + 1`,
    })
    .where(and(
      eq(messagingMessageRefs.backend, deps.backend),
      eq(messagingMessageRefs.externalMessageRef, e.messageRef),
    ));
}

async function handleDelete(deps: EventsDeps, e: Extract<MessagingEvent, { kind: "message_deleted" }>) {
  await deps.db
    .update(messagingMessageRefs)
    .set({ deletedAt: e.deletedAt })
    .where(and(
      eq(messagingMessageRefs.backend, deps.backend),
      eq(messagingMessageRefs.externalMessageRef, e.messageRef),
    ));
}

async function handleReaction(deps: EventsDeps, e: Extract<MessagingEvent, { kind: "reaction_added" | "reaction_removed" }>) {
  const [row] = await deps.db.select().from(messagingMessageRefs)
    .where(and(
      eq(messagingMessageRefs.backend, deps.backend),
      eq(messagingMessageRefs.externalMessageRef, e.messageRef),
    )).limit(1);
  if (!row) return;
  const current: Record<string, string[]> = (row.reactions as Record<string, string[]> | null) ?? {};
  const reactors = new Set(current[e.emoji] ?? []);
  if (e.kind === "reaction_added") reactors.add(e.reactorExternalRef);
  else reactors.delete(e.reactorExternalRef);
  if (reactors.size > 0) current[e.emoji] = [...reactors];
  else delete current[e.emoji];
  await deps.db
    .update(messagingMessageRefs)
    .set({ reactions: current })
    .where(eq(messagingMessageRefs.id, row.id));
}
```

Add `import { sql } from "drizzle-orm";` at top.

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): handle inbound edit/delete/reaction events

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 5.4: Wake dispatch + suppression

**Files:**
- Modify: `server/src/messaging/events.ts`
- Modify: caller wiring in `server/src/index.ts` or equivalent bootstrap (see Part 6)
- Create: `server/src/__tests__/messaging-events-wakes.test.ts`

- [ ] **Step 1: Test** — after a new-message event, existing wake-dispatch machinery fires for the thread assignee. When the ref has `suppressedForWake = true`, no wake fires.

- [ ] **Step 2: Implement**

Extend `handleNewMessage` to, after insert:

```ts
  if (row.suppressedForWake) return;
  if (deps.onMessageCreated) {
    await deps.onMessageCreated(row.id, ch.companyId, th.issueId);
  }
```

Wire `onMessageCreated` to existing `issue-assignment-wakeup.ts` (caller injects the closure in Part 6).

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): respect suppressedForWake; delegate wake dispatch to caller

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 6 — Rewire services

### Task 6.1: services/issues.ts postComment rewired

**Files:**
- Modify: `server/src/services/issues.ts`
- Modify: `server/src/routes/issues.ts`
- Create: `server/src/__tests__/issues-post-comment-messaging.test.ts`

- [ ] **Step 1: Test** — HTTP `POST /api/issues/:id/comments` under `activeBackend='fake'` succeeds, returns a stable UUID, inserts a `messaging_message_refs` row.

- [ ] **Step 2: Read current postComment implementation**

Run: `grep -n "postComment\|createComment" server/src/services/issues.ts`

Identify the function. It currently inserts into `issue_comments`. Replace its body.

- [ ] **Step 3: Implement replacement**

```ts
import { messagingRouter } from "../messaging/index.js";  // module-level singleton, wired in Task 14.2

export async function postComment(args: {
  companyId: string;
  issueId: string;
  authorAgentId?: string;
  authorUserId?: string;
  body: string;
  runId?: string;
}) {
  // Load projectId for router
  const [issue] = await db.select({ projectId: issuesTable.projectId })
    .from(issuesTable).where(eq(issuesTable.id, args.issueId)).limit(1);
  if (!issue) throw notFound("issue not found");

  const res = await messagingRouter.postMessage({
    companyId: args.companyId,
    issueId: args.issueId,
    projectId: issue.projectId!,
    authorAgentId: args.authorAgentId,
    authorUserId: args.authorUserId,
    body: args.body,
    createdByRunId: args.runId,
  });
  return { id: res.id, createdAt: new Date() };
}
```

- [ ] **Step 4: Replace listComments**

```ts
export async function listComments(args: { issueId: string; afterRefId?: string }) {
  return messagingRouter.getThreadMessages({ issueId: args.issueId, afterRefId: args.afterRefId });
}
```

- [ ] **Step 5: Delete the TODO markers from Task 1.8**

- [ ] **Step 6: Typecheck + Run test — expect PASS**

- [ ] **Step 7: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(issues): postComment/listComments go through messaging.router

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 6.2: Hook onIssueStateChange into issue updates

**Files:**
- Modify: `server/src/services/issues.ts` (updateIssue function)
- Create: `server/src/__tests__/issues-update-card-edit.test.ts`

- [ ] **Step 1: Test** — updating an issue's title triggers `router.onIssueStateChange`; FakeAdapter shows the parent message body updated.

- [ ] **Step 2: Implement**

After the DB update commits in `updateIssue`:

```ts
try {
  await messagingRouter.onIssueStateChange(args.issueId);
} catch (err) {
  logger.warn({ err, issueId: args.issueId }, "messaging card edit failed");
}
```

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(issues): sync thread card on issue state change

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 6.3: Feedback service repoint

**Files:**
- Modify: `server/src/services/feedback.ts`
- Create: `server/src/__tests__/feedback-on-message-ref.test.ts`

- [ ] **Step 1: Test** — cast a `feedback_votes` row against a `messaging_message_refs.id`; assert success; ensure old `issue_comment` code paths are gone.

- [ ] **Step 2: Replace target resolution**

In `feedback.ts`, the block that today checks `targetType === "issue_comment"` and loads an `issue_comments` row should be replaced with:

```ts
if (targetType === "messaging_message_ref") {
  const [target] = await db.select().from(messagingMessageRefs)
    .where(eq(messagingMessageRefs.id, targetId)).limit(1);
  if (!target) throw notFound("message ref not found");
  if (!target.authorAgentId) {
    throw unprocessable("Feedback voting is only available on agent-authored messages");
  }
  // build vote payload using messagingMessageRefs fields
}
```

Remove the old `issue_comment` branch and its tests.

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
refactor(feedback): vote target is messaging_message_refs

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 6.4: Wire events processor into server bootstrap

**Files:**
- Create: `server/src/messaging/index.ts`
- Modify: `server/src/app.ts` (or equivalent startup)

- [ ] **Step 1: Create module index exposing singletons**

```ts
import { createDb, type Db } from "@paperclipai/db";
import { messagingRegistry } from "./registry.js";
import { createMessagingRouter, type MessagingRouter } from "./router.js";
import { createEventsProcessor, type EventsProcessor } from "./events.js";
import type { BackendKey } from "./types.js";
import { dispatchIssueCommentedWake, dispatchIssueCommentMentionedWake }
  from "../services/issue-assignment-wakeup.js";

let router: MessagingRouter | null = null;
let events: EventsProcessor | null = null;
let backend: BackendKey = "fake";

export function initMessaging(args: { db: Db; backend: BackendKey }): void {
  backend = args.backend;
  router = createMessagingRouter({ db: args.db, registry: messagingRegistry, backend });
  events = createEventsProcessor({
    db: args.db,
    backend,
    onMessageCreated: async (refId, companyId, issueId) => {
      await dispatchIssueCommentedWake({ refId, companyId, issueId });
      // TODO (Task 9.3): also dispatch mention wakes
    },
  });
}

export function getMessagingRouter(): MessagingRouter {
  if (!router) throw new Error("messaging not initialized");
  return router;
}

export function getEventsProcessor(): EventsProcessor {
  if (!events) throw new Error("messaging events not initialized");
  return events;
}

export { messagingRegistry };
```

- [ ] **Step 2: Bootstrap wiring**

In `server/src/app.ts` (or wherever startup lives), after DB init:

```ts
import { initMessaging } from "./messaging/index.js";
import { createFakeAdapter } from "./messaging/adapters/fake/adapter.js";
import { messagingRegistry } from "./messaging/registry.js";

messagingRegistry.register(createFakeAdapter());
initMessaging({ db, backend: /* read from messaging_company_config in per-request context; default 'fake' */ "fake" });
```

Note: per-company backend switching lives in Task 14.2.

- [ ] **Step 3: Run `pnpm --filter @paperclipai/server typecheck`**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): bootstrap router + events with FakeAdapter default

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 6.5: issue_attachments column rename in services

**Files:**
- Modify: `server/src/services/*` (any references to `issueCommentId`)

- [ ] **Step 1: Find usages**

Run: `grep -rn "issueCommentId\|issue_comment_id" server/src`

- [ ] **Step 2: Replace each with `messagingMessageRefId`/`messaging_message_ref_id`**. Typecheck until clean.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(attachments): follow issue_comment_id → messaging_message_ref_id rename

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 7 — Slack adapter skeleton

### Task 7.1: Slack adapter scaffolding

**Files:**
- Create: `server/src/messaging/adapters/slack/adapter.ts` (capability + stub methods)
- Create: `server/src/__tests__/slack-adapter-capabilities.test.ts`

- [ ] **Step 1: Write capability test**

```ts
import { describe, it, expect } from "vitest";
import { createSlackAdapter } from "../messaging/adapters/slack/adapter.js";

describe("slack adapter", () => {
  it("declares expected capabilities", () => {
    const a = createSlackAdapter({ /* deps stubbed — see Task 7.2 */ } as any);
    expect(a.backendKey).toBe("slack");
    expect(a.capabilities).toMatchObject({
      supportsThreads: true,
      supportsFileUpload: true,
      requiresUserAuthPerIdentity: true,
    });
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
import type { MessagingAdapter, CapabilityFlags } from "../../types.js";

export interface SlackDeps {
  fetchBotToken(companyId: string): Promise<string>;
  fetchUserToken(secretId: string): Promise<string>;
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

export function createSlackAdapter(deps: SlackDeps): MessagingAdapter {
  return {
    backendKey: "slack",
    capabilities,
    // All operations throw by default; filled in later tasks.
    async createChannel() { throw new Error("not implemented"); },
    async archiveChannel() { throw new Error("not implemented"); },
    async addChannelMember() { throw new Error("not implemented"); },
    async removeChannelMember() { throw new Error("not implemented"); },
    async createThread() { throw new Error("not implemented"); },
    async lockThread() { throw new Error("not implemented"); },
    async postMessage() { throw new Error("not implemented"); },
    async editMessage() { throw new Error("not implemented"); },
    async deleteMessage() { throw new Error("not implemented"); },
    async getThreadMessages() { throw new Error("not implemented"); },
    async getMessage() { throw new Error("not implemented"); },
    async provisionAgentIdentity() { throw new Error("not implemented"); },
    async resolveExternalUser() { throw new Error("not implemented"); },
    normalizeEvent() { return null; },
  };
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): adapter scaffolding + capability flags

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 7.2: Token store

**Files:**
- Create: `server/src/messaging/adapters/slack/token-store.ts`

- [ ] **Step 1: Implement**

Reuse existing `company_secrets` service. Keep this module thin:

```ts
import { getSecretValue, putSecretValue } from "../../../services/company-secrets.js";

export async function storeBotToken(companyId: string, token: string): Promise<string> {
  return putSecretValue({ companyId, purpose: "messaging.slack.bot_token", value: token });
}
export async function storeSigningSecret(companyId: string, secret: string): Promise<string> {
  return putSecretValue({ companyId, purpose: "messaging.slack.signing_secret", value: secret });
}
export async function storeUserToken(companyId: string, agentId: string, token: string): Promise<string> {
  return putSecretValue({
    companyId,
    purpose: `messaging.slack.user_token.${agentId}`,
    value: token,
  });
}
export async function fetchSecret(secretId: string): Promise<string> {
  return getSecretValue(secretId);
}
```

Verify the exact signatures of `company-secrets.ts` first; adjust `purpose` usage to match.

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): token store helpers on company_secrets

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 7.3: Slack WebClient wrapper with retry

**Files:**
- Create: `server/src/messaging/adapters/slack/client.ts`
- Create: `server/src/__tests__/slack-client-retry.test.ts`

- [ ] **Step 1: Test** — 429 with `Retry-After: 1` retried up to 3 times via `vi.useFakeTimers()`.

- [ ] **Step 2: Implement**

```ts
import { WebClient } from "@slack/web-api";
import { MessagingBackendUnavailable } from "../../types.js";

export interface SlackClientOpts {
  token: string;
  retries?: number;
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.data?.error === "ratelimited" || err?.status === 429) {
        const retryAfter = Number(err?.headers?.["retry-after"] ?? 2);
        if (attempt === retries - 1) {
          throw new MessagingBackendUnavailable("slack rate limited", "rate_limited", retryAfter);
        }
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (err?.status && err.status >= 500 && err.status < 600) {
        if (attempt === retries - 1) {
          throw new MessagingBackendUnavailable("slack 5xx", "backend_5xx");
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new MessagingBackendUnavailable("retry loop exhausted", "exhausted");
}

export function slackClient(token: string): WebClient {
  return new WebClient(token);
}
```

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): WebClient wrapper with retry/backoff

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 7.4: Signing-secret verification

**Files:**
- Create: `server/src/messaging/adapters/slack/signing.ts`
- Create: `server/src/__tests__/slack-signing.test.ts`

- [ ] **Step 1: Test** — valid signature passes; tampered body fails; old timestamp (>5 min) fails.

- [ ] **Step 2: Implement**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackSignature(args: {
  signingSecret: string;
  timestampHeader: string;
  signatureHeader: string;
  rawBody: string;
  nowSec?: number;
}): boolean {
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const ts = Number(args.timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 60 * 5) return false;
  const base = `v0:${args.timestampHeader}:${args.rawBody}`;
  const expected = "v0=" + createHmac("sha256", args.signingSecret).update(base).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(args.signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): signing-secret verification helper

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 8 — Slack adapter operations

### Task 8.1: Slack createChannel + archive + members

**Files:**
- Modify: `server/src/messaging/adapters/slack/adapter.ts`

- [ ] **Step 1: Implement (skipping failing-test step for thin API pass-throughs; instead cover via integration smoke in Part 15)**

```ts
// inside createSlackAdapter:
async createChannel({ name, purpose }) {
  const client = await deps.getBotClient();
  const res = await withRetry(() => client.conversations.create({ name, is_private: false }));
  return { externalRef: res.channel!.id!, name: res.channel!.name! };
},
async archiveChannel(ref) {
  const client = await deps.getBotClient();
  await withRetry(() => client.conversations.archive({ channel: ref }));
},
async addChannelMember(channelRef, identityRef) {
  const client = await deps.getBotClient();
  await withRetry(() => client.conversations.invite({ channel: channelRef, users: identityRef }));
},
async removeChannelMember(channelRef, identityRef) {
  const client = await deps.getBotClient();
  await withRetry(() => client.conversations.kick({ channel: channelRef, user: identityRef }));
},
```

Extend `SlackDeps` with `getBotClient(companyId?): Promise<WebClient>`.

- [ ] **Step 2: Typecheck + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): channel create/archive/member operations

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 8.2: Slack createThread + issue card Block Kit

**Files:**
- Create: `server/src/messaging/adapters/slack/blocks.ts`
- Modify: `server/src/messaging/adapters/slack/adapter.ts`

- [ ] **Step 1: Implement Block Kit builder**

```ts
import type { IssueCardInput } from "../../issue-card.js";

export function issueCardBlocks(input: IssueCardInput) {
  return [
    { type: "header", text: { type: "plain_text", text: `[${input.identifier}] ${input.title}` } },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*${input.status}*` },
        input.assigneeDisplay ? { type: "mrkdwn", text: `assignee ${input.assigneeDisplay}` } : null,
        input.priority ? { type: "mrkdwn", text: `priority ${input.priority}` } : null,
      ].filter(Boolean),
    },
    input.descriptionExcerpt
      ? { type: "section", text: { type: "mrkdwn", text: input.descriptionExcerpt } }
      : null,
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open in Paperclip" }, url: input.issueUrl },
      ],
    },
  ].filter(Boolean);
}
```

- [ ] **Step 2: Implement createThread**

```ts
async createThread({ channelRef, parentBlocks, fallbackText }) {
  const client = await deps.getBotClient();
  const res = await withRetry(() => client.chat.postMessage({
    channel: channelRef,
    text: fallbackText,
    blocks: parentBlocks ?? undefined,
  }));
  return { threadRef: res.ts!, parentMessageRef: res.ts! };
},
```

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): createThread posts issue card as thread parent

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 8.3: Slack postMessage (user token)

**Files:**
- Modify: `server/src/messaging/adapters/slack/adapter.ts`

- [ ] **Step 1: Implement**

```ts
async postMessage({ channelRef, threadRef, authorIdentity, body, blocks }) {
  if (authorIdentity.credential.kind !== "user_token") {
    throw new Error("slack postMessage requires a user-token credential");
  }
  const token = await deps.fetchUserToken(authorIdentity.credential.secretId);
  const client = slackClient(token);
  const res = await withRetry(() => client.chat.postMessage({
    channel: channelRef,
    thread_ts: threadRef,
    text: body,
    blocks: blocks as any,
  }));
  return { messageRef: res.ts!, createdAt: new Date(Number(res.ts) * 1000) };
},
```

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): postMessage via user token

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 8.4: Slack editMessage / deleteMessage / getMessage / getThreadMessages

**Files:**
- Modify: `server/src/messaging/adapters/slack/adapter.ts`

- [ ] **Step 1: Implement all four**

```ts
async editMessage(messageRef, body, blocks) {
  const client = await deps.getBotClient();
  await withRetry(() => client.chat.update({
    channel: /* channel? — pass via args; add channelRef to editMessage signature */ "",
    ts: messageRef,
    text: body,
    blocks: blocks as any,
  }));
},
async deleteMessage(messageRef, by) {
  const token = by.credential.kind === "user_token"
    ? await deps.fetchUserToken(by.credential.secretId)
    : await deps.getBotToken();
  const client = slackClient(token);
  await withRetry(() => client.chat.delete({ channel: "", ts: messageRef }));
},
async getMessage(messageRef) {
  // Slack has no getMessage; use conversations.history with latest=ts+inclusive
  // Adjust signature to accept channelRef.
  return null;
},
async getThreadMessages(threadRef) {
  const client = await deps.getBotClient();
  // Caller passes { channel, thread_ts }. Extend signature to accept channelRef.
  // Returned messages mapped into canonical Message shape.
  return [];
},
```

Slack APIs need the channel ref alongside `ts`. Extend router + adapter interface to carry `channelRef` through `editMessage`/`deleteMessage`/`getMessage`/`getThreadMessages`. Update types.ts accordingly.

- [ ] **Step 2: Update types.ts + router to pass channelRef**

(Small sweep; pass channel from pointer rows through to adapter calls.)

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): edit/delete/read message operations

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 8.5: Slack normalizeEvent

**Files:**
- Modify: `server/src/messaging/adapters/slack/adapter.ts`
- Create: `server/src/__tests__/slack-normalize.test.ts`

- [ ] **Step 1: Test** — feed a real Slack `message` / `message_changed` / `message_deleted` / `reaction_added` payload; assert canonical event shape.

- [ ] **Step 2: Implement**

```ts
normalizeEvent(raw) {
  const evt = (raw as any)?.event;
  if (!evt) return null;
  switch (evt.type) {
    case "message":
      if (evt.subtype === "message_changed") {
        return {
          kind: "message_changed",
          externalEventId: (raw as any).event_id,
          messageRef: evt.message?.ts,
          channelRef: evt.channel,
          bodyRaw: evt.message?.text ?? "",
          editedAt: new Date(Number(evt.message?.edited?.ts) * 1000),
        };
      }
      if (evt.subtype === "message_deleted") {
        return {
          kind: "message_deleted",
          externalEventId: (raw as any).event_id,
          messageRef: evt.deleted_ts,
          channelRef: evt.channel,
          deletedAt: new Date(Number(evt.event_ts) * 1000),
        };
      }
      return {
        kind: "message",
        externalEventId: (raw as any).event_id,
        channelRef: evt.channel,
        threadRef: evt.thread_ts,
        messageRef: evt.ts,
        authorExternalRef: evt.user,
        bodyRaw: evt.text ?? "",
        createdAt: new Date(Number(evt.ts) * 1000),
      };
    case "reaction_added":
    case "reaction_removed":
      return {
        kind: evt.type,
        externalEventId: (raw as any).event_id,
        messageRef: evt.item?.ts,
        channelRef: evt.item?.channel,
        reactorExternalRef: evt.user,
        emoji: evt.reaction,
        at: new Date(Number(evt.event_ts) * 1000),
      };
    default:
      return null;
  }
},
```

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): normalizeEvent for message/edit/delete/reactions

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 9 — Translation (mentions + mrkdwn)

### Task 9.1: mrkdwn.fromGfm

**Files:**
- Create: `server/src/messaging/adapters/slack/mrkdwn.ts`
- Create: `server/src/__tests__/slack-mrkdwn.test.ts`

- [ ] **Step 1: Test round-trips for bold/italic/code/lists/links/tables**

- [ ] **Step 2: Implement (regex-based; fine for MVP)**

```ts
export function fromGfm(gfm: string): string {
  return gfm
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, _lang, body) => "```\n" + body + "```")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[(.+?)\]\((.+?)\)/g, "<$2|$1>")
    .replace(/^[*-]\s+/gm, "• ")
    .replace(/^- \[ \] /gm, "☐ ")
    .replace(/^- \[x\] /gmi, "☑ ");
}

export function toGfm(mrkdwn: string): string {
  return mrkdwn
    .replace(/<([^|]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/\*(.+?)\*/g, "**$1**")
    .replace(/^•\s+/gm, "- ");
}
```

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): GFM <-> mrkdwn translation

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 9.2: mention-parser

**Files:**
- Create: `server/src/messaging/adapters/slack/mention-parser.ts`
- Create: `server/src/__tests__/slack-mentions.test.ts`

- [ ] **Step 1: Test**

- [ ] **Step 2: Implement**

```ts
import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { messagingIdentities, agents } from "@paperclipai/db";

export async function toExternalMentions(db: Db, companyId: string, body: string): Promise<string> {
  const names = Array.from(body.matchAll(/\B@([\w-]+)/g), (m) => m[1]);
  if (!names.length) return body;
  const rows = await db.select({
    agentName: agents.name,
    externalRef: messagingIdentities.externalUserRef,
  })
    .from(messagingIdentities)
    .innerJoin(agents, eq(messagingIdentities.agentId, agents.id))
    .where(and(
      eq(messagingIdentities.backend, "slack"),
      eq(messagingIdentities.companyId, companyId),
      inArray(agents.name, names as string[]),
    ));
  const byName = new Map(rows.map((r) => [r.agentName, r.externalRef]));
  return body.replace(/\B@([\w-]+)/g, (_full, name) => {
    const ext = byName.get(name);
    return ext ? `<@${ext}>` : `@${name}`;
  });
}

export async function toInternalMentions(db: Db, body: string): Promise<{
  rewritten: string;
  mentionedAgentIds: string[];
}> {
  const refs = Array.from(body.matchAll(/<@([A-Z0-9]+)>/g), (m) => m[1]);
  if (!refs.length) return { rewritten: body, mentionedAgentIds: [] };
  const rows = await db.select({
    externalRef: messagingIdentities.externalUserRef,
    agentId: messagingIdentities.agentId,
    agentName: agents.name,
  })
    .from(messagingIdentities)
    .leftJoin(agents, eq(messagingIdentities.agentId, agents.id))
    .where(and(
      eq(messagingIdentities.backend, "slack"),
      inArray(messagingIdentities.externalUserRef, refs as string[]),
    ));
  const byRef = new Map(rows.map((r) => [r.externalRef, r]));
  const rewritten = body.replace(/<@([A-Z0-9]+)>/g, (_full, ref) => {
    const row = byRef.get(ref);
    return row?.agentName ? `@${row.agentName}` : `<@${ref}>`;
  });
  const mentionedAgentIds = rows.map((r) => r.agentId!).filter(Boolean);
  return { rewritten, mentionedAgentIds };
}
```

- [ ] **Step 3–5: Run, PASS, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): mention translation with agent id resolution

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 9.3: Wire translation into router postMessage and events handler

**Files:**
- Modify: `server/src/messaging/router.ts`
- Modify: `server/src/messaging/events.ts`

- [ ] **Step 1: Router — translate mentions + mrkdwn before calling adapter.postMessage** (for Slack backend; no-op for fake).

- [ ] **Step 2: Events handler — translate body back to GFM for downstream consumers; include mentionedAgentIds in wake dispatch.**

- [ ] **Step 3: Extend `onMessageCreated` signature to include mentions**

```ts
onMessageCreated?: (refId: string, companyId: string, issueId: string, mentionedAgentIds: string[]) => Promise<void>;
```

- [ ] **Step 4: Fire `issue_comment_mentioned` wakes for each mentioned agent** (see `issue-assignment-wakeup.ts` helpers).

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): wire mention translation + mention-wake dispatch

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 10 — OAuth flows + HTTP routes

### Task 10.1: Bot OAuth install endpoints

**Files:**
- Create: `server/src/routes/messaging-slack-oauth.ts`
- Modify: `server/src/routes/index.ts` (mount)

- [ ] **Step 1: Implement `GET /api/messaging/slack/oauth/bot/start`**

Redirects to `https://slack.com/oauth/v2/authorize?client_id=...&scope=<bot scopes>&redirect_uri=...&state=<jwt(companyId,nonce,exp)>`.

- [ ] **Step 2: Implement `GET /api/messaging/slack/oauth/bot/callback`**

- Verify state JWT (same secret used to sign).
- POST `https://slack.com/api/oauth.v2.access` with `code`, `client_id`, `client_secret`.
- Extract `access_token`, `team.id`, `bot_user_id`.
- `storeBotToken(companyId, access_token)` → secretId.
- Accept signing secret via UI once, `storeSigningSecret(companyId, secret)`.
- Insert `messaging_workspace_install` row.
- Redirect to `/companies/<slug>/settings/messaging?ok=1`.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): bot OAuth install endpoints

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 10.2: Per-agent user OAuth endpoints

**Files:**
- Modify: `server/src/routes/messaging-slack-oauth.ts`

- [ ] **Step 1: Implement `GET /api/messaging/slack/oauth/user/start?agentId=…`**

State encodes `{ companyId, agentId, nonce }`. Redirects to Slack user-scope authorize URL.

- [ ] **Step 2: Implement `GET /api/messaging/slack/oauth/user/callback`**

- Verify state, load agent row.
- POST `oauth.v2.access`. Extract `authed_user.id` and `authed_user.access_token`.
- Reject if another identity already holds `authed_user.id`.
- `storeUserToken(companyId, agentId, access_token)` → secretId.
- Upsert `messaging_identities` row (`agentId`, `backend='slack'`, `externalUserRef=authed_user.id`, `authBlobSecretId=secretId`, `state='active'`).
- Redirect to `/.../agents/<agent>`.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): per-agent user-token OAuth endpoints

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 10.3: Slack events webhook endpoint

**Files:**
- Create: `server/src/routes/messaging-slack-events.ts`
- Modify: `server/src/routes/index.ts`

- [ ] **Step 1: Implement `POST /api/messaging/slack/events`**

```ts
app.post("/api/messaging/slack/events", async (req, res) => {
  const raw = req.rawBody ?? JSON.stringify(req.body);
  const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  // URL verification
  if (parsed?.type === "url_verification") {
    return res.json({ challenge: parsed.challenge });
  }

  // Signature verification
  const teamId = parsed?.team_id;
  const install = await findInstallByTeamId(teamId);
  if (!install) return res.status(404).send();
  const signingSecret = await fetchSecret(install.signingSecretId);
  const ok = verifySlackSignature({
    signingSecret,
    timestampHeader: req.headers["x-slack-request-timestamp"] as string,
    signatureHeader: req.headers["x-slack-signature"] as string,
    rawBody: raw,
  });
  if (!ok) return res.status(401).send();

  // ACK fast
  res.json({ ok: true });

  // Process async
  const adapter = messagingRegistry.require("slack");
  const normalized = adapter.normalizeEvent(parsed);
  if (!normalized) return;
  try {
    await getEventsProcessor().handle(normalized);
  } catch (err) {
    logger.error({ err }, "slack events processor failed");
  }
});
```

- [ ] **Step 2: Interactivity endpoint** (`POST /api/messaging/slack/interactivity`) — stub only for MVP; Phase 1.5 fills this in. Return `200 {}` after signature check.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): events + interactivity webhooks

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 11 — Attachments

### Task 11.1: Outbound attachment upload

**Files:**
- Modify: `server/src/messaging/adapters/slack/adapter.ts`
- Modify: `server/src/messaging/router.ts`

- [ ] **Step 1: Implement `SlackAdapter.uploadFileToThread(channelRef, threadRef, bytes, filename, contentType)`**

Use `client.files.getUploadURLExternal` + `client.files.completeUploadExternal`. Returns Slack file ID.

- [ ] **Step 2: Router.postMessage accepts `attachments`; after postMessage, upload each file to the same thread; record `slackFileId` in `messaging_message_refs.metadata`.**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging/slack): upload attachments to thread

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 11.2: Inbound attachment ingest

**Files:**
- Modify: `server/src/messaging/events.ts`

- [ ] **Step 1: When a `message` event carries `files[]`, download each via user token, store in Paperclip blob store, insert `issue_attachments` FK'd to new message ref id.**

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): ingest inbound file attachments

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 12 — Inbox (`#paperclip-inbox`)

### Task 12.1: Inbox service + identity auto-discovery

**Files:**
- Create: `server/src/messaging/inbox.ts`
- Modify: bot OAuth callback (Task 10.1)
- Create: tests

- [ ] **Step 1: Auto-discovery** — on bot install, call `users.list` via bot token; for each Paperclip `users` row whose `email` matches a Slack member's `profile.email`, insert `messaging_identities` (`userId`, `externalUserRef`, `authBlobSecretId=NULL`, `state='active'`).

- [ ] **Step 2: Inbox event dispatch**

Hook the following Paperclip service entry points to call `inbox.notify`:
- Issue assignment → "new assignment"
- Direct @-mention → "mentioned"
- Approval request → "approval requested"
- Status change on user-owned issue → "status"

`inbox.notify(userId, event)` looks up or creates the inbox DM channel via `adapter.createChannel({ purpose:'inbox' })` (for Slack, really `conversations.open`), builds a Block Kit message with a deep link, posts as bot.

- [ ] **Step 3: Dedup** — within 2-minute window, edit the last inbox message instead of posting a new one.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): #paperclip-inbox service with dedup

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 12.2: Subscription preferences UI + API

**Files:**
- Create: `server/src/routes/messaging-inbox.ts`
- Modify: `ui/src/pages/SettingsMessaging.tsx` (created in Part 13)

- [ ] **Step 1: `PATCH /api/messaging/inbox-prefs`** — updates `messaging_identities.inboxPreferences`.

- [ ] **Step 2: UI component — toggles for the six default event types.**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): inbox subscription preferences

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 13 — Settings UI

### Task 13.1: `Settings → Messaging` page scaffold

**Files:**
- Create: `ui/src/pages/SettingsMessaging.tsx`
- Modify: `ui/src/routes/*` (add nav entry)

- [ ] **Step 1: Minimal page with three panes: Workspace connection, Agent identities, My inbox.**

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ui): Settings → Messaging page scaffold

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 13.2: Workspace connect + identity list + agent link flow

**Files:**
- Modify: `ui/src/pages/SettingsMessaging.tsx`
- Modify: agent profile page (add "Slack link status")

- [ ] **Step 1: Workspace pane** — "Connect Slack workspace" button → `window.location = '/api/messaging/slack/oauth/bot/start'`. Show connected state + disconnect button when installed.

- [ ] **Step 2: Agent identities pane** — table: agent name, state (active/pending/revoked), "Link" button → opens `/api/messaging/slack/oauth/user/start?agentId=…` in new tab.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ui): workspace connect + per-agent link flows

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 14 — Config + enforcement

### Task 14.1: 412/409 error codes

**Files:**
- Modify: `server/src/errors.ts` (or equivalent)
- Modify: `server/src/services/issues.ts` postComment

- [ ] **Step 1: Define new error classes / codes**

`messaging_not_configured` (412), `agent_identity_not_linked` (412), `messaging_identity_revoked` (412), `messaging_thread_locked` (409), `messaging_rate_limited` (429), `messaging_backend_unavailable` (503).

- [ ] **Step 2: `postComment` checks config and surfaces the right code before calling the router.**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): error codes + config gate at comment boundary

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 14.2: Per-company backend switching

**Files:**
- Modify: `server/src/messaging/index.ts`

- [ ] **Step 1: Resolve `activeBackend` from `messaging_company_config` per request.**

Rather than a process-singleton router with a single backend, expose:

```ts
export function getMessagingRouterForCompany(companyId: string): Promise<MessagingRouter>;
```

Cache router instances per (backend) — the registry is shared; the router's `backend` field is the only thing that varies.

- [ ] **Step 2: Callers updated**

Every call-site in `services/issues.ts`, `services/feedback.ts`, `inbox.ts`, etc. passes `companyId` through.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): per-company backend resolution

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Part 15 — Polish + smoke

### Task 15.1: Soft thread lock on `done`/`cancelled`

**Files:**
- Modify: `server/src/services/issues.ts` (status change path)
- Modify: `server/src/messaging/events.ts`

- [ ] **Step 1: When an issue transitions to `done` or `cancelled`, mark `messaging_threads.state='locked'`.**

- [ ] **Step 2: In events.ts, drop new-message events for locked threads and post a bot reply "This thread is locked." Skip wake dispatch.**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): soft thread lock on issue completion

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 15.2: Telemetry counters + histograms

**Files:**
- Modify: `server/src/messaging/router.ts`, `events.ts`, `adapters/slack/adapter.ts`

- [ ] **Step 1: Add the counters/histograms from the spec's Telemetry section using existing `telemetry.ts`.**

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): telemetry counters + histograms

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 15.3: Admin diagnose endpoint

**Files:**
- Modify: `server/src/routes/messaging-slack-events.ts` (or new `messaging-admin.ts`)

- [ ] **Step 1: `GET /api/messaging/diagnose/:issueId`** — returns thread ref, last 10 message refs, last adapter call status (pulled from telemetry).

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(messaging): admin diagnose endpoint

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 15.4: End-to-end smoke test with FakeAdapter

**Files:**
- Create: `server/src/__tests__/e2e-fake-messaging.test.ts`

- [ ] **Step 1: Test covering full flow**

- Seed company, project, issue, two agents, two identities
- Agent A posts comment → refs row created, echo event fires, wake dispatched
- Agent B receives wake → posts reply
- Edit Agent A's message → editedAt set
- Delete → deletedAt set
- Status change → thread card edited

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
test(messaging): end-to-end fake-adapter smoke

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

### Task 15.5: Optional Slack E2E (env-gated)

**Files:**
- Create: `server/src/__tests__/e2e-slack-messaging.test.ts`

- [ ] **Step 1: Gated `describe` — runs only when `PAPERCLIP_SLACK_E2E_TOKEN` is set.**

- [ ] **Step 2: Against a dedicated test workspace: create channel, post message, read thread, edit, delete.**

- [ ] **Step 3: Add `just test:slack-e2e` recipe.**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
test(messaging/slack): optional real-Slack E2E smoke

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
```

---

## Spec coverage check (self-review)

- ✅ Field-ownership table — encoded structurally: router writes refs, events writes edit/delete/reaction, adapter never writes DB.
- ✅ All schema tables — Part 1.
- ✅ `createdByRunId`, `editedAt`, `editCount`, `deletedAt`, `suppressedForWake`, `reactions` columns — Task 1.5.
- ✅ `issue_attachments` FK rename — Tasks 1.8, 6.5.
- ✅ `feedback_votes` target repoint — Tasks 1.8, 6.3.
- ✅ `issue_comments` drop + fresh-start migration — Tasks 1.8, 1.9.
- ✅ `MessagingAdapter` interface + capability flags — Task 2.1.
- ✅ Registry — Task 2.2.
- ✅ FakeAdapter — Task 3.1.
- ✅ Router (channel, thread, post, read, card update, membership) — Part 4.
- ✅ Events processor (dedup, new, edit, delete, reaction, wake suppression) — Part 5.
- ✅ Wire into services/issues.ts, feedback.ts, attachments — Part 6.
- ✅ Slack adapter (capabilities, client, signing, operations, normalizeEvent) — Parts 7–8.
- ✅ Translation (mentions, mrkdwn) — Part 9.
- ✅ OAuth flows (bot + per-agent user) — Part 10.
- ✅ Events/interactivity webhooks — Task 10.3.
- ✅ Attachments Phase 1 round-trip — Part 11.
- ✅ `#paperclip-inbox` with auto-discovery, dedup, preferences — Part 12.
- ✅ Settings UI (workspace + agent link) — Part 13.
- ✅ Config enforcement + 412/409 codes — Part 14.
- ✅ Soft thread lock — Task 15.1.
- ✅ Telemetry, diagnose endpoint — Tasks 15.2–3.
- ✅ Smoke tests — Tasks 15.4–5.

**Deliberately deferred (Phase 1.5 per spec):**
- Approval Block Kit buttons — Task 10.3 only stubs the interactivity route.
- Slack reactions → `feedback_votes` bridging.
- Derived search index (`messaging_message_index`).
- Private-channel inbox mode.
- Auto-archive on project done.

**Things the agent should double-check at implementation time:**
- Exact export name for `users` in `auth.ts` (Task 1.1) — may be `appUsers` or similar.
- Exact signatures of `putSecretValue`/`getSecretValue` in `company-secrets.ts` (Task 7.2).
- Existing `issue-assignment-wakeup.ts` exports for `dispatchIssueCommentedWake` / `dispatchIssueCommentMentionedWake` — if the functions don't exist under those names, use whatever the module currently exposes for comment wakes and match the signature.
