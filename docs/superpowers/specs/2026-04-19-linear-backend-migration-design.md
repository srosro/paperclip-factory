# Linear Backend Migration — Design Spec

Date: 2026-04-19
Status: Draft, pending implementation plan
Predecessor: `docs/superpowers/specs/2026-04-17-slack-first-comms-design.md` (retained as historical reference)
Related beads epic: `pc-330` (Slack-first hardening) — closed; this spec supersedes it

## Goal

Replace the Slack-first messaging integration with Linear as the canonical issue-tracking and communication surface for Paperclip. Linear becomes the **source of truth for issue state**; Paperclip keeps agent runtime state and acts as the execution engine behind Linear-authored work. The Slack adapter we just shipped retires entirely on the new branch.

This migration also corrects a data-model mistake we caught while designing the switch: the existing `messaging_channels` / `messaging_threads` / `messaging_message_refs` schema is a Slack-shaped abstraction (channels contain threads contain messages) that does not fit issue-tracker transports. The new design uses an issue-native schema (`issues` + `issue_comment_refs`) that maps cleanly onto Linear, GitHub Issues, Jira, or any future issue-tracker adapter.

## Non-goals

- Maintaining two messaging backends. Slack is out of the picture for the foreseeable future.
- Data migration of Slack-era issues (SAM-1..9 in Plow). Clean cut — existing issues that lack a Linear mirror get cancelled/archived on first Linear launch.
- Linear Cycle / Project Milestone / Project Update integration. Paperclip doesn't model cycles or project milestones today; deferred.
- Inbox DMs. Slack's per-user bot DM concept has no Linear equivalent; dropped.
- Generic cross-adapter abstractions (a hypothetical future `ChatAdapter` alongside `IssueTrackerAdapter`). Defer until a second adapter of either type is actually needed.

## Locked-in decisions

These were made explicitly during brainstorming on 2026-04-19. Recorded here so the spec is self-contained.

1. **Full replacement.** Linear is the only messaging backend. Slack adapter retired.
2. **Per-agent Linear seats.** Each agent is a real Linear user with its own paid seat. OAuth per agent mirrors the Slack user-OAuth flow we built.
3. **Linear is source of truth for issue state.** Paperclip's `issues` table becomes a thin write-through cache.
4. **Company → Linear team; Paperclip project → Linear Project.** One team per Paperclip company; multiple Linear Projects inside it, one per Paperclip project.
5. **Subscribe to every Linear event with a Paperclip equivalent** (Issue, Comment, IssueLabel, Reaction, Attachment, Project). Skip Cycle / ProjectMilestone / ProjectUpdate.
6. **Label sync is in scope for MVP.** New `messaging_label_refs` table maps Paperclip label UUIDs ↔ Linear label UUIDs.
7. **Refactor the messaging schema to be issue-centric (P2).** Drop `messaging_channels` and `messaging_threads`; rename `messaging_message_refs` → `issue_comment_refs`; redesign the adapter interface as `IssueTrackerAdapter`.
8. **New branch `feat/linear-backend`** from current HEAD. Slack adapter deleted on that branch. `feat/slack-first-comms` stays on the fork as historical reference.
9. **Clean cut for Plow.** Pre-existing SAM-1..9 issues (mostly done/cancelled) archive on the new branch's first launch. Sam starts fresh in Linear.

## Architecture overview

Paperclip core stays the same in shape. The messaging layer's authority and primitive-set changes.

```
       ┌─────────────────┐         ┌──────────────────┐
       │  Paperclip core │◄─────►  │  LinearAdapter   │──────► Linear GraphQL API
       │  (runtime, wake)│ events  │  (new)           │◄────── Linear webhooks
       └─────────────────┘         └──────────────────┘
                 │                           ▲
                 ▼                           │
       ┌─────────────────┐                   │
       │ cached issues,  │                   │
       │ issue_comment_  │◄──────────────────┘
       │   refs, etc.    │   cache-sync
       └─────────────────┘
```

**Outbound flow (agent writes):**
1. Agent calls Paperclip HTTP API (`POST /api/issues/:id/comments`, `POST /api/companies/:id/issues`, `PATCH /api/issues/:id`, etc.)
2. Paperclip `issuesService` / router calls `LinearAdapter`
3. LinearAdapter performs GraphQL mutation using the agent's OAuth token (posts as that Linear user natively)
4. Linear acks; adapter stamps a short-lived self-origination marker and caches the result into `issues` / `issue_comment_refs`
5. Linear later echoes the same change via webhook; the marker causes the webhook handler to skip re-processing

**Inbound flow (human writes in Linear UI):**
1. Linear webhook → `POST /api/messaging/linear/events`
2. Signature-verify, 200 ack within budget, enqueue async
3. Dedup via `messaging_events_inbox` on Linear's stable `event.id`
4. `LinearAdapter.normalizeEvent` translates the webhook payload to a canonical `MessagingEvent`
5. Events processor runs two handlers concurrently:
   - **Wake** — `handleMessageCreatedSideEffects` (reused verbatim from Slack-era): skip if `suppressedForWake`, wake assignee on comment, wake @mentioned agents, dispatch inbox DMs for user mentions (no-op in Linear era)
   - **Sync** — `syncFromLinearEvent` (new): idempotent upsert into local `issues`, `issue_comment_refs`, `issue_labels`, `issue_attachments` tables

**Key architectural reuse:** every piece of Slack-era plumbing not specific to Slack stays:
- `resolveMessagingContext(companyId)` per-company resolver
- `messaging_workspace_install`, `messaging_identities`, `messaging_events_inbox`, `messaging_company_config`
- Encrypted secret storage via `company_secrets` + `local_encrypted` provider
- `handleMessageCreatedSideEffects` unified wake pipeline
- `bot_system` principal fallback for agents without identities
- Typed error taxonomy (`MessagingNotConfigured`, `MessagingIdentityNotActive`, `MessagingBackendUnavailable`, `MessagingThreadLocked`)
- `readiness` states in the admin status endpoint
- Per-company context caching + `invalidateMessagingContext`

## Data model

### Schema refactor

Slack-era tables `messaging_channels` and `messaging_threads` are dropped. `messaging_message_refs` is renamed and its FK reparented.

**Dropped:**
- `messaging_channels` — "channel" is not a Linear primitive; nothing to model
- `messaging_threads` — a Linear issue *is* the thread; the indirection adds nothing

**Renamed + reparented:**
- `messaging_message_refs` → `issue_comment_refs`
- FK changes: `messaging_message_refs.threadId → messaging_threads.id` becomes `issue_comment_refs.issueId → issues.id`
- All other columns preserved: `backend`, `externalMessageRef` (now Linear comment UUID), `authorAgentId`, `authorUserId`, `createdByRunId`, `firstSeenAt`, `editedAt`, `editCount`, `deletedAt`, `suppressedForWake`, `reactions`, `metadata`
- Unique index: `(issue_id, external_message_ref)` — the invariant we shipped in Track 3 carries over: no two refs in one issue share a Linear comment UUID

**Added columns:**
- `issues.linear_issue_id uuid` — Linear's internal issue UUID. Unique partial index where not null.
- `issues.linear_issue_identifier text` — Linear-generated human identifier (e.g. `SAI-1`). Denormalized from Linear's `identifier` field for fast display. Optional (can compute from team key + counter but caching avoids extra API calls).
- `projects.linear_project_id uuid` — Linear Project UUID. Unique partial index where not null.

**New table:**
- `messaging_label_refs`
  - `id uuid PK`
  - `company_id uuid FK companies`
  - `backend text NOT NULL`
  - `paperclip_label_id uuid FK labels` (NOT NULL)
  - `external_label_ref text NOT NULL` (Linear label UUID)
  - Unique: `(paperclip_label_id, backend)` partial where not null
  - Unique: `(company_id, backend, external_label_ref)`
  - Tracks the sync correspondence so label changes in either direction resolve correctly

### Repurposed (no schema change) tables

| Table | Linear meaning |
|---|---|
| `messaging_workspace_install` | Per-company Linear OAuth app install; `backend='linear'`, `externalWorkspaceRef` = Linear organization UUID, `botUserRef` = Linear OAuth app actor id |
| `messaging_identities` | Per-(agent\|user, company, backend='linear') identity; `externalUserRef` = Linear user UUID; `authBlobSecretId` points at the encrypted user-scoped OAuth token in `company_secrets` |
| `messaging_events_inbox` | Webhook dedup keyed on `(backend='linear', externalEventId=<Linear event.id>)` |
| `messaging_company_config` | `active_backend` accepts `'linear'` (in addition to the existing `'fake'` for tests and the historical `'slack'` which now never appears in production) |
| `company_secrets` / `company_secret_versions` | Encrypted Linear OAuth tokens; no change |

### Paperclip-only tables (never projected to Linear)

These stay in Paperclip and have no Linear representation:

- `approvals`, `approval_comments` — approval gate is a Paperclip concept
- `budget_policies`, `budget_incidents` — Paperclip-specific
- `heartbeat_runs`, `heartbeat_run_events`, `agent_runtime_state`, `agent_task_sessions`, `agent_wakeup_requests` — runtime/execution state
- `activity_log` — internal audit trail
- `feedback_votes` — may project to Linear reactions in a later phase
- `goals`, `project_goals` — Linear milestones are a rough match, deferred

### Projected with 1:1 mapping (MVP scope)

- `issues` ↔ Linear issues (title, description, status, priority, assignee, identifier)
- `issue_comment_refs` ↔ Linear comments (body lives in Linear)
- `issue_attachments` ↔ Linear attachments
- `issue_relations` ↔ Linear issue relations (blocks, blocked-by, related)
- `labels` / `issue_labels` ↔ Linear labels (via `messaging_label_refs`)
- `projects` ↔ Linear Projects (within the single company team)

### Status mapping

Paperclip's `issues.status` enum maps onto Linear workflow states by state **type**. Each Linear team has a customizable set of workflow states; we resolve the mapping on first use and cache it in `companies.metadata.linearWorkflowStateMap`.

| Paperclip `status` | Linear state type | Preferred Linear state name |
|---|---|---|
| `todo` | `unstarted` | Todo |
| `in_progress` | `started` | In Progress |
| `in_review` | `started` | In Review (or any `started` state named similarly) |
| `blocked` | `started` | Blocked (name-match); fallback: any `started` state |
| `done` | `completed` | Done |
| `cancelled` | `canceled` | Canceled |

If a team's workflow doesn't have all six distinct states, the status endpoint surfaces `readiness: 'workflow_mapping_incomplete'` and the admin is prompted to either (a) add missing states in Linear or (b) provide a custom mapping in company config. No writes happen until the mapping is complete.

### Priority mapping

Linear stores priority as an integer 0–4; Paperclip uses string enums.

| Paperclip `priority` | Linear `priority` |
|---|---|
| `critical` | `1` (Urgent) |
| `high` | `2` (High) |
| `medium` | `3` (Medium) |
| `low` | `4` (Low) |
| unset / null | `0` (No priority) |

Mapping is fixed (not team-configurable).

### Migration plan

One migration file on `feat/linear-backend` does:

1. Add `issues.linear_issue_id`, `issues.linear_issue_identifier`, `projects.linear_project_id` columns + partial unique indexes
2. Create `messaging_label_refs` table
3. Create `issue_comment_refs` as a new table with the new FK
4. Copy existing rows from `messaging_message_refs` into `issue_comment_refs`, joining through `messaging_threads` to resolve the target `issueId`
5. Drop `messaging_message_refs`, `messaging_threads`, `messaging_channels`
6. Drop related indexes

The migration is forward-only. Branch-scope only: `feat/slack-first-comms` never runs it.

## Adapter structure + OAuth flows

### Interface change: `MessagingAdapter` → `IssueTrackerAdapter`

The Slack-shaped interface:

```ts
// before
interface MessagingAdapter {
  createChannel / archiveChannel / addChannelMember / removeChannelMember
  createThread / lockThread
  postMessage / editMessage / deleteMessage / getThreadMessages
  provisionAgentIdentity / resolveExternalUser
  normalizeEvent
}
```

becomes:

```ts
// after
interface IssueTrackerAdapter {
  readonly backendKey: 'linear' | 'fake';
  readonly capabilities: CapabilityFlags;

  // Issue lifecycle
  createIssue(args: CreateIssueArgs): Promise<IssueRef>;
  updateIssue(args: UpdateIssueArgs): Promise<IssueRef>;
  getIssue(externalIssueRef: string): Promise<Issue | null>;
  archiveIssue(externalIssueRef: string): Promise<void>;

  // Comments
  postComment(args: PostCommentArgs): Promise<CommentRef>;
  editComment(externalCommentRef: string, body: string): Promise<void>;
  deleteComment(externalCommentRef: string, by: AuthorIdentity): Promise<void>;
  getComments(externalIssueRef: string, opts?: PaginationOpts): Promise<Comment[]>;
  getComment(externalCommentRef: string): Promise<Comment | null>;

  // Labels
  ensureLabel(name: string, color?: string): Promise<ExternalLabelRef>;
  setIssueLabels(externalIssueRef: string, externalLabelRefs: string[]): Promise<void>;

  // Attachments
  uploadAttachment(args: UploadAttachmentArgs): Promise<AttachmentRef>;

  // Identities
  provisionAgentIdentity(args: ProvisionAgentIdentityArgs): Promise<ProvisionResult>;
  resolveExternalUser(externalRef: string): Promise<InternalUserRef | null>;

  // Webhook
  normalizeEvent(raw: unknown): MessagingEvent | null;
}
```

The `CapabilityFlags` shape loses Slack-specific flags (`supportsThreadLock`, `requiresUserAuthPerIdentity` stays), gains `supportsLinearNativePriorities`, `supportsIssueRelations`, `supportsLabels`.

The `MessagingEvent` discriminated union changes:

```ts
type MessagingEvent =
  | { kind: 'issue_created'; externalIssueRef; createdByExternalRef; ... }
  | { kind: 'issue_updated'; externalIssueRef; changedFields: {...}; ... }
  | { kind: 'issue_assignee_changed'; externalIssueRef; newAssigneeExternalRef; ... }
  | { kind: 'issue_removed'; externalIssueRef; ... }
  | { kind: 'comment_created'; externalIssueRef; externalCommentRef; authorExternalRef; bodyRaw; ...; mentionedExternalRefs: string[] }
  | { kind: 'comment_updated'; externalCommentRef; bodyRaw; editedAt }
  | { kind: 'comment_deleted'; externalCommentRef; deletedAt }
  | { kind: 'reaction_added' | 'reaction_removed'; externalCommentRef; emoji; reactorExternalRef }
  | { kind: 'labels_changed'; externalIssueRef; addedExternalRefs; removedExternalRefs }
  | { kind: 'attachment_changed'; externalIssueRef; ... }
  | { kind: 'project_changed'; externalProjectRef; ... };
```

### Directory layout

```
server/src/messaging/adapters/linear/
  adapter.ts            # IssueTrackerAdapter impl
  client.ts             # GraphQL client over fetch; retry, backoff, error taxonomy
  graphql.ts            # GraphQL operation strings and typed result shapes
  oauth-app.ts          # Workspace OAuth install flow
  oauth-user.ts         # Per-agent user OAuth flow
  webhook.ts            # Signature verification + ack + enqueue
  events-normalize.ts   # Webhook payload → MessagingEvent
  cache-sync.ts         # Apply events to local tables (issues, issue_comment_refs, ...)
  workflow-state-map.ts # Linear state UUIDs ↔ Paperclip status strings, resolved + cached per-team
  label-sync.ts         # messaging_label_refs reconciliation
  types.ts              # Linear-specific types
```

### App install (per-company OAuth)

1. Admin visits `/api/messaging/linear/oauth/app/start?companyId=<id>`
2. Paperclip redirects to Linear OAuth consent (scopes: `read write issues:create comments:create`; also request `app:assignable app:mentionable` so the bot can be assigned work and @mentioned in issues)
3. Linear redirects back to `/api/messaging/linear/oauth/app/callback?code=…&state=…`
4. Paperclip exchanges the code for a workspace-scoped access token; stores it encrypted in `company_secrets` (name: `messaging.linear.app_token`)
5. Paperclip queries Linear's `organization` + `teams` via GraphQL. If a team exists with `key = companies.issue_prefix`, adopt it. Otherwise create one via `teamCreate` with that key.
6. Writes:
   - `messaging_workspace_install` row with `backend='linear'`, `externalWorkspaceRef` = organization UUID, `botUserRef` = OAuth app actor id
   - `messaging_channels` equivalent — since there is no channel concept in Linear, the single "team anchor" lives in a small addition to `messaging_workspace_install.metadata.linearTeamId`
   - `messaging_company_config.active_backend = 'linear'` (auto-enable on install, same pattern as Slack)
7. Registers the Linear webhook for the relevant resource types via `webhookCreate` mutation
8. Resolves workflow state mapping and caches in `companies.metadata.linearWorkflowStateMap`
9. Redirects admin to `/<COMPANY_PREFIX>/company/settings/messaging?linear_installed=1`

### Per-agent OAuth

1. Admin clicks "Link Linear identity" next to an agent in Settings → Messaging
2. Paperclip generates a state token: `{ kind: 'linear_user_oauth', companyId, agentId, nonce, exp }` (10-minute TTL, same pattern as Slack)
3. Admin opens `/api/messaging/linear/oauth/user/start?agentId=<id>` → redirected to Linear OAuth with user scopes (`read write comments:create`)
4. Admin must be logged into Linear as the agent's Slack-equivalent account (invite `sam+ceo@plow.co` to Linear first; the browser should be signed into that account before clicking Link)
5. Callback at `/api/messaging/linear/oauth/user/callback` exchanges code for user-scoped token
6. Paperclip records `messaging_identities` row with `backend='linear'`, `externalUserRef` = Linear user UUID, `authBlobSecretId` pointing at the encrypted token
7. Redirects to `/<COMPANY_PREFIX>/company/settings/messaging?linear_linked=<agentId>`

### Agent posts as its own Linear user

When `router.postComment({ issueId, authorAgentId, body })` resolves:
1. Load the agent's `messaging_identities` row for the active backend
2. If missing: fall back to `bot_system` authoring (posts as the workspace OAuth app principal) — same safety net we shipped for Slack
3. If present, decrypt the user-scoped token from `company_secrets`
4. LinearAdapter posts via GraphQL with that token → Linear attributes the comment to the agent's Linear user

### Onboarding concession

Linear doesn't have a "channel invite" concept — team members are workspace-level. The per-agent OAuth flow requires the agent's Linear user to **already exist in the workspace** before we can obtain a token for it. We handle this by either:

- Manually inviting `sam+ceo@plow.co` etc. to the Linear workspace before starting OAuth (admin does this via Linear's UI), OR
- Programmatically inviting via `organizationInviteCreate` during the "Link Linear identity" click if the agent's expected email isn't yet a workspace member, then emailing the invite.

MVP: manual invite. Admin invites each agent's email to the Linear workspace first, then runs the OAuth flow. Automation via `organizationInviteCreate` (or whichever invite mutation Linear exposes) is deferred; we verify the exact mutation when we get to that phase.

## Events webhook + wake pipeline

### Subscribed event classes

Paperclip subscribes to the following Linear webhook resource types (mapping 1:1 with entities Paperclip models):

- `Issue` — create / update / remove
- `Comment` — create / update / remove
- `IssueLabel` — create / update / remove
- `Reaction` — create / remove
- `Attachment` — create / remove
- `Project` — create / update / remove

Not subscribed (Paperclip has no equivalent): `Cycle`, `ProjectMilestone`, `ProjectUpdate`, `Organization`.

### Wake + sync table

| Linear event | Normalized kind | Wake behavior | Cache-sync behavior |
|---|---|---|---|
| `Comment.create` | `comment_created` | Wake issue assignee (skip if author = assignee). Parse body for `@agent` mentions → wake each. | Insert `issue_comment_refs` row. |
| `Comment.update` | `comment_updated` | None. | Bump `editedAt`, `editCount`. |
| `Comment.remove` | `comment_deleted` | None. | Set `deletedAt`. |
| `Reaction.create` | `reaction_added` | None. (Future phase may project to `feedback_votes`.) | Update `reactions` jsonb on the comment ref. |
| `Reaction.remove` | `reaction_removed` | None. | Update `reactions` jsonb. |
| `Issue.create` (assigned to an agent) | `issue_created` | Wake the assignee with reason `issue_assigned`. | Insert `issues` row with `linear_issue_id`. |
| `Issue.update` (assignee changed) | `issue_assignee_changed` | Wake new assignee with `issue_assigned`. | Update `issues.assigneeAgentId`. |
| `Issue.update` (state type → `unstarted` or `triage`) | `issue_state_changed_to_open` | Optional — wake the assignee if configured. | Update `issues.status`. |
| `Issue.update` (any other field) | `issue_updated` | None. | Update the changed fields in `issues`. |
| `Issue.remove` | `issue_removed` | None. | Soft-delete (mark cancelled). |
| `IssueLabel.*` | `labels_changed` | None. | Reconcile `issue_labels`. |
| `Attachment.*` | `attachment_changed` | None. | Mirror into `issue_attachments`. |
| `Project.*` | `project_changed` | None. | Update `projects` row. |

### Handler pipeline

```
POST /api/messaging/linear/events
  ├─ webhook.ts: signature verify (HMAC-SHA256 of body with Linear webhook secret)
  ├─ Ack 200 fast (Linear's 10s budget)
  ├─ messaging_events_inbox dedup insert (backend='linear', externalEventId = Linear event.id)
  ├─ LinearAdapter.normalizeEvent → MessagingEvent
  └─ events processor handle(event):
       ├─ Wake leg: handleMessageCreatedSideEffects (reused from Slack era)
       │     suppressedForWake check / assignee wake / mentioned-agent wakes
       └─ Sync leg: syncFromLinearEvent (new)
             Idempotent upsert into issues / issue_comment_refs / issue_labels / issue_attachments
```

### Self-origination filtering

When Paperclip-originated writes echo back as webhook events, both legs should no-op. Implementation:

1. On each Linear write from the adapter (create issue, post comment, etc.), record in a short-lived in-memory LRU: `expected[linearEventId] = { expiresAt: now + 60s }`. Linear's event id is returned in the mutation response.
2. Webhook processor checks the LRU on each event. If hit → mark event as `paperclip_originated=true` and skip both wake and sync handlers (sync is unnecessary because Paperclip already wrote the cache).
3. To survive server restarts, also persist `originatedBy='paperclip'` on the `messaging_events_inbox` row at Paperclip-write time. Webhook processor checks the persisted flag too. LRU is the fast path; DB is the fallback.

### Approvals surfacing

Approvals don't exist in Linear. When an agent creates an approval (via `POST /api/companies/:id/approvals`), Paperclip also posts a comment on the linked issue saying _"Approval requested — decide here: <link to Paperclip approvals UI>"_. The comment is posted via the adapter using the `bot_system` principal (the workspace OAuth app). Humans can click through to Paperclip to approve; no Linear-native state change is involved.

## Mutation paths (outbound writes)

Every mutation from Paperclip's side writes to Linear first, then updates the local cache:

```
issuesService.addComment(issueId, body, actor)
  → resolveMessagingContext(companyId)
  → ctx.router.postComment({ issueId, authorAgentId, authorUserId, body })
      → load issue.linear_issue_id from cache
      → load author identity (agent → user OAuth token, user → bot_system)
      → LinearAdapter.postComment({ externalIssueRef: linear_issue_id, authorIdentity, body })
          → Linear GraphQL commentCreate mutation with the agent's user token
          → Linear returns { id: <comment UUID>, createdAt: ... }
      → stamp expected[linearEventId] in self-origination LRU
      → insert issue_comment_refs row with externalMessageRef = commentUUID
  → return to route handler
```

### Issue creation path

```
POST /api/companies/:id/issues
  → issuesService.create({ title, description, assigneeAgentId, projectId, ... })
      → resolveMessagingContext(companyId)
      → LinearAdapter.createIssue({
          teamId: <linear team id from workspace install>,
          projectId: <linear project id if provided, else null>,
          title, description,
          assigneeId: <linear user id from messaging_identities for the agent>,
          stateId: <linear state id from workflow map for 'todo'>,
          priority: <0-4 from priority map>,
          labelIds: <resolved via messaging_label_refs>
        })
          → Linear GraphQL issueCreate → returns { id: linearUUID, identifier: 'SAI-1', ... }
      → stamp self-origination marker
      → insert issues row with
          id = uuid (Paperclip internal),
          linear_issue_id = linearUUID,
          linear_issue_identifier = 'SAI-1',
          identifier = 'SAI-1',  -- copy for display
          title, description, assignee, status, priority = copy from returned Linear issue
  → return { id, identifier } to caller
```

`companies.issue_counter` is unused. Linear generates identifiers.

### Issue state changes

Status and priority changes from Paperclip (agents flipping status to `in_progress`, `done`, etc.) map through the state/priority translation layer:

```
issuesService.update(issueId, { status: 'in_progress' })
  → LinearAdapter.updateIssue({
      externalIssueRef: linear_issue_id,
      stateId: workflowStateMap.get('in_progress'),
    })
```

Self-origination marker applied; cache updated to match.

## Code cleanup + transition

### Branch strategy

- `feat/slack-first-comms` stays on the fork (`srosro/paperclip-factory`). Do not delete. This is the reference for the complete Slack-era implementation.
- New branch `feat/linear-backend` off the current HEAD of `feat/slack-first-comms`.
- All work described in this spec happens on `feat/linear-backend`.
- Migrations on the new branch are forward-only. The old branch never runs them.

### Commit plan (rough)

The implementation plan (next step after this spec is approved) will refine this, but the expected order is:

1. **Delete Slack.** Remove `server/src/messaging/adapters/slack/*`, `server/src/routes/messaging-slack.ts`, `server/src/messaging/inbox.ts`, Slack-specific tests (`slack-oauth-routes.test.ts`, `slack-events-webhook.test.ts`, `slack-adapter-capabilities.test.ts`, `slack-mention-parser.test.ts`). Trim Slack scopes from `messaging-settings-routes`, Slack env plumbing from `app.ts`.
2. **Schema refactor.** Migration: add `linear_issue_id`, `linear_project_id`, `messaging_label_refs`, `issue_comment_refs`; copy data from `messaging_message_refs`; drop `messaging_channels`, `messaging_threads`, `messaging_message_refs`.
3. **Interface refactor.** Rename `MessagingAdapter` → `IssueTrackerAdapter`; rewrite `router.ts` around issue/comment primitives; update `events.ts`, `services/issues.ts`, `services/heartbeat.ts`, `services/feedback.ts`, `routes/issues.ts`. Fake adapter stays, adapted to the new interface. All existing non-Slack tests pass.
4. **Linear adapter skeleton.** Add the directory structure with stubs for each interface method. Client module with GraphQL wrapper. No real behavior yet.
5. **Linear OAuth.** App install + per-agent flows, mirrors Slack OAuth routes we deleted.
6. **Linear adapter methods.** Fill in each GraphQL operation; workflow-state resolution; priority mapping.
7. **Webhook + normalize + cache-sync.** Signature verify, normalizeEvent per event class, cache-sync handler.
8. **End-to-end smoke tests.** Against a stubbed GraphQL server; then against a real Linear workspace (env-gated).
9. **Migration script for Plow on wakeup.** Drops the Slack workspace install rows, Slack identities; cancels existing SAM issues; clears `messaging_company_config` so admin goes through Linear install on next UI visit.

### Transition for Plow specifically

On wakeup (after merging `feat/linear-backend`):

1. Stop paperclip dev server
2. Run migrations
3. Restart → company state is `readiness: 'disabled'` (old `active_backend='slack'` was cleared during migration)
4. Admin opens Settings → Messaging → "Connect Linear workspace"
5. Goes through app OAuth with the Paperclip Factory Linear app
6. Invites `sam+ceo@plow.co`, `sam+cto@plow.co`, `sam+engmgr@plow.co`, `sam+techlead@plow.co`, `sam+developer@plow.co` to the Linear workspace
7. Per-agent Linear OAuth for each
8. Status flips `disabled → not_installed → agent_identities_incomplete → ready` as each step completes
9. Creates a new project in Paperclip UI (plow-dev) → auto-provisions a Linear Project with the same name
10. First issue `SAI-1` in Linear kicks off fresh

Sam's Plow Peeps existing Slack-era issues (SAM-1..9) stay in the `issues` table (nothing deleted) but have `linear_issue_id IS NULL`. On the first Linear-era launch, a cleanup job marks them `cancelled` with a comment explaining they're archived Slack-era work. They're still readable in Paperclip's UI for reference.

### Slack app retirement

The Slack workspace install on Plow's Slack workspace (`plow-wakeup.ngrok.io` tunnel, Paperclip Factory app) can stay configured on Slack's side — it's harmless. We just stop using it. Env vars `SLACK_APP_CLIENT_ID` / `SLACK_APP_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` can be removed from `~/.paperclip/instances/default/.env` (or left, ignored). The bot user, the `#proj-plow-dev` channel, and the agent Slack users (`sam+ceo`, etc.) persist in Slack; nothing cleans them up. Admin can delete them manually if desired.

## Testing strategy

### Test layers

1. **Unit** — workflow-state mapping, priority mapping, `normalizeEvent` per Linear event class, self-origination LRU + DB fallback, webhook signature verification, label-sync reconciliation
2. **Router integration** — FakeAdapter (adapted to new interface) + real Postgres; end-to-end through `issuesService`. Issue create, comment post, status change; all verifying the cache ends up in the expected state.
3. **LinearAdapter integration** — against a stubbed GraphQL server (nock or a small test double). Covers each mutation + each event type. Validates token handling, retry behavior, error taxonomy.
4. **OAuth integration** — stubbed Linear token exchange endpoints; verify `messaging_identities` + `company_secrets` rows, encrypted token round-trip, state-token TTL and nonce verification, redirect to the company-prefixed settings page.
5. **Webhook integration** — simulated Linear webhook payloads → dedup → normalize → handleMessageCreatedSideEffects wake + cache-sync. Matches the pattern from `slack-events-webhook.test.ts`.
6. **E2E (opt-in, env-gated)** — against a real Linear workspace + test tokens. Not in CI. `just test:linear-e2e` locally when touching the adapter.

### Key test scenarios

Ported from `messaging-hardening.test.ts` + new:

- Multi-company routing never leaks (two Paperclip companies, each with its own Linear workspace install — an event into one cannot touch the other's state)
- Comment-ref uniqueness holds under the new `(issue_id, external_message_ref)` key (inherited invariant from Track 3)
- Queued-comment cancel flips `suppressedForWake` not `deletedAt` (same invariant)
- `bot_system` fallback when agent identity missing
- Self-origination filter prevents double-processing of Paperclip-originated webhooks
- Status mapping resolves team-specific state UUIDs on first use and caches them
- Label sync bidirectional — creating a label in Paperclip creates it in Linear; creating it in Linear mirrors back
- Workflow mapping incomplete → `readiness: 'workflow_mapping_incomplete'`
- Agent identity missing → `readiness: 'agent_identities_incomplete'`

## Risks and open questions

### Risks

1. **Linear rate limits.** Linear's default is 1000 req/hour per OAuth client. For a small team this is plenty. Large deployments need per-workspace OAuth apps or request budgeting. Defer mitigation until observed.
2. **Self-origination filtering robustness.** The in-memory LRU is lost on server restart. The DB fallback (`messaging_events_inbox.originatedBy='paperclip'`) covers the durable case but adds latency to the outbound write path. Worth verifying this is fast enough in practice.
3. **Workflow state customizability.** Linear teams can customize state names and even state types. If a team removes or renames states Paperclip's mapping expects, the status endpoint correctly surfaces `workflow_mapping_incomplete` but admin has to fix it. Needs clear UX.
4. **Linear OAuth scope changes.** Future Paperclip features may need additional scopes (e.g., reactions:write, attachments:write if we ever write them directly). Scope changes require users to re-install the app. Document this in release notes when it happens.
5. **Per-agent seat cost.** Each agent = one Linear seat. For Plow (5 agents) this is manageable; for larger deployments it could add up. No mitigation in MVP; reconsider if adoption scales.
6. **Linear webhook retries.** Linear retries failed deliveries. Dedup via `messaging_events_inbox` handles it, but we should verify our 10s ack budget is achievable even on slow DB hops.

### Resolved questions (2026-04-19)

1. **Linear workspace:** New workspace to be created for Paperclip Factory (no existing workspace reused). Created before OAuth-app setup.
2. **Linear plan tier:** Basic ($10/user/mo). Enough for MVP and all webhook/OAuth features we need.
3. **Team key / prefix:** `SAI`. Sam's Plow Peeps' `companies.issue_prefix` migrates `SAM → SAI` as part of the Linear-backend migration, so Paperclip URLs (`/SAI/...`) align with Linear identifiers (`SAI-1`, `SAI-2`, ...).
4. **Agent email convention:** reuse Slack-era `sam+<role>@plow.co` pattern (`sam+ceo@plow.co`, `sam+cto@plow.co`, `sam+engmgr@plow.co`, `sam+techlead@plow.co`, `sam+developer@plow.co`).
5. **Invite flow:** manual invites for MVP. Admin invites each agent email to the Linear workspace, then runs per-agent OAuth. Programmatic `organizationInviteCreate` deferred.
6. **CTO account:** yes, invite a real `sam+cto@plow.co` seat now. CTO gets its own Linear user; no bot_system fallback.
7. **Board user identity:** `so@plow.co` — Sam's real Linear account. `messaging_identities` row for `local-board` ↔ `so@plow.co`'s Linear user UUID, resolved via auto-discovery (email match) during app install.
8. **FakeAdapter retention:** keep, retargeted to `IssueTrackerAdapter`. Tests depend on it.
9. **SAM-1..9 treatment on first Linear launch:** cancel each, add an auto-comment: _"Archived: Slack-era Paperclip Factory work; migrated to Linear on 2026-04-19."_ Issues remain readable in Paperclip for reference.
10. **`feedback_votes` FK retarget:** yes — migration must repoint the FK from `messaging_message_refs.id` → `issue_comment_refs.id`. Data-preserving.
11. **Slack helper scripts (`slack-smoke.ts`, `plow-dev-bootstrap.ts`, `plow-dev-finish.ts`):** delete on `feat/linear-backend`. They're Slack-era one-offs.
12. **Ngrok:** reuse `paperclip-factory.ngrok.app` → wakeup:3100. Linear webhooks arrive at a different path (`/api/messaging/linear/events`).
13. **Slack retirement:** delete the Paperclip Factory Slack app at api.slack.com, archive `#proj-plow-dev` in Slack, remove `sam-ceo` / `sam-engmgr` / `so+techlead` / `sam-eng` from the Plow Slack workspace, remove `SLACK_*` env vars from `~/.paperclip/instances/default/.env`.
14. **Linear Project visibility:** team-wide (default).
15. **Label color:** use Paperclip's `labels.color` when set; deterministic hash of label name otherwise.
16. **Paperclip Factory Linear OAuth app registration:** admin registers at `linear.app/settings/api/applications` before the OAuth flow is exercised. Credentials land in env as `LINEAR_APP_CLIENT_ID`, `LINEAR_APP_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`.

## Merge gate

The next architecture iteration is not complete until all are true:

- `MessagingAdapter` renamed to `IssueTrackerAdapter` with issue-centric primitives
- `messaging_channels`, `messaging_threads`, `messaging_message_refs` dropped; `issue_comment_refs` in place with migration copying data forward
- `issues.linear_issue_id`, `projects.linear_project_id`, `messaging_label_refs` landed
- LinearAdapter implements every interface method against real Linear GraphQL
- OAuth flows (app install + per-agent user) work end-to-end on wakeup
- Webhook receives, dedups, normalizes, wakes, and syncs correctly
- `handleMessageCreatedSideEffects` pipeline reused verbatim; passes all existing wake tests (adapted for new event shapes)
- Bot-system fallback + `readiness` state reporting survive the refactor
- Plow's wakeup instance boots on Linear-only, has agents OAuth'd, and can post a round-trip comment (agent → Linear → webhook → wake → agent replies)

## Explicit non-goals (reiterated)

- No Slack adapter maintained alongside Linear on this branch
- No data migration of historical SAM-1..9 issues into Linear
- No inbox DM surface (Slack-era concept; Linear has no equivalent)
- No cycle / project-milestone / project-update integration
- No pluggable second adapter (`ChatAdapter` vs. `IssueTrackerAdapter`) — deferred until a second backend of either type is needed
- No Slack ambient-awareness layer on top of Linear — may come as a follow-on but not in this migration
