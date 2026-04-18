# Slack-first Comms for Paperclip — Design Spec

Date: 2026-04-17
Status: Draft, pending implementation plan

## Goal

Make Slack the single, authoritative surface for all Paperclip communication. Every agent↔agent, agent↔user, and approval/status event happens in Slack. If it is not in Slack, it does not exist. The design must be pluggable so Slack can be replaced later by Discord, Matrix, or other backends without changing core.

## Non-goals

- Replacing Paperclip's issue, workflow, approval, or execution state — only the comment/message surface moves.
- Auto-provisioning Slack user accounts via SCIM or similar (deferred; manual invite + OAuth dance for MVP).
- Cross-company merged inbox, digest summaries, slash commands (deferred to later phases).
- **Local message-body backup.** No mirror store, no durable outbox, no replay queue. Slack owns every body byte. If Slack is down, Paperclip comments pause — intentional.
- **Production routing to the fake adapter.** The fake adapter is a test/dev fixture only. No production code path selects `fake` because Slack env vars happen to be absent or the workspace happens to be uninstalled.

## Phase 1 scope freeze

Phase 1 production behavior is **Slack-or-disabled, per company**, resolved on every request from per-company state — not from process-global environment variables:

- The only production backend is Slack. Future backends (Discord, Matrix, etc.) arrive in Phase 3; they do not bleed into Phase 1 routing.
- Whether a company has messaging enabled is determined by `messaging_company_config.activeBackend` + `messaging_workspace_install`. Presence of Slack env vars in the server process is a prerequisite for Slack working at all, but does not implicitly enable Slack for any company.
- Multi-company deployments are first-class. Each company has its own workspace install, its own identities, its own channels. There is no global "currently-selected backend".
- The fake adapter remains registered, but only for tests and local dev loops that explicitly opt in via `messaging_company_config.activeBackend = 'fake'` (or an equivalent test-time harness). Production deployments never route through it.

Merge gate for any follow-on architecture pass: routing, identity resolution, and side effects must all be company-scoped. A request for company A must be structurally incapable of touching company B's messaging state.

## High-level shape

- **Upstream feature**, not a fork. Lives in mainline Paperclip, off by default per company, on when `messaging_company_config.activeBackend` is set.
- **Domain-specific canonicality.** Slack owns conversational message bodies, edits, deletes, and reactions. Paperclip owns issue state, approvals, run ↔ message linkage, wake routing, channel membership, and everything else orchestration-related. See the **field ownership** table below.
- **No local message bodies.** `messaging_message_refs` stores pointers + Paperclip-owned orchestration metadata (run linkage, edit/delete timestamps, wake suppression) but never body text. Reads fetch live from Slack via the adapter. A derived search index may land in a later phase if rate-limit pain shows up; not in MVP.
- **Core interface + built-in Slack:** `MessagingAdapter` is a first-class core concept alongside `AgentAdapter`. Slack ships as a built-in adapter. Future backends ride the plugin system.
- **In-process, fail-fast:** adapter lives inside the Paperclip server process. Slack API failure propagates as a normal API error; no outbox, no durable queue. Slack outage = Paperclip comments paused, by design.
- **User-token-per-agent identity:** each agent is a real Slack user (paid seat, real email). One Slack app, installed once with bot scopes, installed once per agent with user scopes. Agents post using their user tokens — native Slack identity, native `@mentions`, native DMs.

### Field ownership

| Field | Owner | Notes |
|---|---|---|
| Message body, edits, deletes, reactions | **Slack** | Paperclip never stores body text; edits/deletes reflect in `messaging_message_refs` timestamps only |
| Issue title, description, status, assignee, priority, labels | **Paperclip** | Slack thread card is a projection; editing Paperclip updates the card |
| Approval decision state | **Paperclip** | Slack buttons (Phase 1.5) are a control surface; state lives in `approvals` |
| Run ↔ message linkage, wake suppression | **Paperclip** | First-class columns on `messaging_message_refs` |
| Channel membership | **Paperclip, via adapter** | Bot is sole channel manager; humans don't invite/kick manually |
| Attachments (file bytes) | **Slack** (primary) + Paperclip blob store (cached on ingest) | See Attachments section |
| Feedback votes on agent-authored messages | **Paperclip** | Targets `messaging_message_refs.id`; see Feedback section |

## Architecture

### Module layout

```
server/src/messaging/
├── types.ts                   # MessagingAdapter interface, capability flags, ref types
├── router.ts                  # backend-agnostic routing; writes pointer rows
├── registry.ts                # adapter registration
├── events.ts                  # inbound event → ref updates → wake dispatch
├── provisioning.ts            # channel/identity provisioning orchestration
└── adapters/
    ├── fake/                   # in-memory adapter for tests and local dev
    │   └── adapter.ts
    └── slack/
        ├── adapter.ts          # implements MessagingAdapter
        ├── app-manifest.json   # one Slack app manifest — bot + user scopes
        ├── oauth-bot.ts        # workspace-level bot install
        ├── oauth-user.ts       # per-agent user-token install flow
        ├── token-store.ts      # user token persistence via company_secrets
        ├── events-webhook.ts   # POST /api/messaging/slack/events
        ├── interactivity.ts    # POST /api/messaging/slack/interactivity
        ├── mrkdwn.ts           # GFM ↔ Slack mrkdwn translation
        └── mention-parser.ts   # <@U…> ↔ agent id mapping
```

### Module boundaries

- `services/issues.ts` comment path calls `messaging.router.postMessage()` instead of writing to `issue_comments`.
- `messaging.router` is the only writer to `messaging_threads` and the initial insert to `messaging_message_refs`.
- `messaging.events` is the only writer to `messaging_message_refs` edit/delete/reaction timestamps.
- `messaging.router` is the only module that invites/removes channel members (bot is sole channel manager in Slack — humans cannot manually alter membership; enforced by Slack role config).
- `messaging.adapters.slack` is the only module importing `@slack/web-api` / `@slack/bolt`. Core contains zero Slack-specific code.

### Adapter interface

```ts
interface MessagingAdapter {
  backendKey: string;  // 'slack', 'fake', etc.
  capabilities: CapabilityFlags;

  // Channels / threads
  createChannel(args: CreateChannelArgs): Promise<ChannelRef>;
  archiveChannel(channelRef: string): Promise<void>;
  addChannelMember(channelRef: string, identityRef: string): Promise<void>;
  createThread(args: CreateThreadArgs): Promise<ThreadRef>;
  lockThread(threadRef: string): Promise<void>;  // may be soft-lock for backends without native

  // Messages
  postMessage(args: PostMessageArgs): Promise<MessageRef>;
  editMessage(messageRef: string, body: Body): Promise<void>;
  deleteMessage(messageRef: string): Promise<void>;
  getThreadMessages(threadRef: string, opts?: PaginationOpts): Promise<Message[]>;
  getMessage(messageRef: string): Promise<Message | null>;

  // Identities
  provisionAgentIdentity(args: ProvisionAgentIdentityArgs): Promise<ProvisionResult>;
  resolveExternalUser(externalRef: string): Promise<InternalUserRef | null>;

  // Events (inbound, normalized)
  normalizeEvent(raw: unknown): MessagingEvent | null;
}

interface CapabilityFlags {
  supportsThreads: boolean;
  supportsEditing: boolean;
  supportsReactions: boolean;
  supportsButtons: boolean;
  supportsFileUpload: boolean;
  supportsThreadLock: boolean;        // native; simulated by core if false
  requiresUserAuthPerIdentity: boolean;
}
```

### Slack adapter capability declaration

```ts
{
  supportsThreads: true,
  supportsEditing: true,
  supportsReactions: true,
  supportsButtons: true,
  supportsFileUpload: true,
  supportsThreadLock: false,             // soft-locked via messaging_threads.state
  requiresUserAuthPerIdentity: true,
}
```

### Topology

- **Channel per Paperclip project.** Slack channel named `proj-<project-url-key>`. Members: agents assigned/commenting on issues in that project, plus relevant humans.
- **Thread per issue.** Each issue has exactly one Slack thread inside its project's channel.
- **Thread parent message = issue card.** Posted by the workspace bot using Block Kit. Edited in place on status/assignee/title changes so the top of every thread shows current state.
- **`#paperclip-inbox`:** per-user DM with the bot, one per human. Digest-style push notifications for assignments, @-mentions, approvals, and status changes on owned issues.

## Data model

### New tables

```sql
messaging_workspace_install
  id                     uuid PK
  companyId              uuid FK companies
  backend                text
  externalWorkspaceRef   text
  workspaceName          text
  botUserRef             text
  botTokenSecretId       uuid FK company_secrets
  signingSecretId        uuid FK company_secrets
  installedByUserId      uuid FK users
  installedAt, updatedAt timestamptz
  UNIQUE (companyId, backend)

messaging_channels
  id                     uuid PK
  companyId              uuid FK companies
  backend                text
  purpose                text          -- 'project' | 'inbox' | 'ad_hoc'
  projectId              uuid FK projects      NULLABLE
  userId                 uuid FK users         NULLABLE
  externalChannelRef     text
  externalChannelName    text
  state                  text          -- 'active' | 'archived'
  createdAt, updatedAt   timestamptz
  UNIQUE (backend, externalChannelRef)
  UNIQUE (companyId, backend, purpose, projectId) WHERE purpose='project'
  UNIQUE (companyId, backend, purpose, userId)    WHERE purpose='inbox'
  CHECK ( (purpose='project' AND projectId IS NOT NULL)
       OR (purpose='inbox'   AND userId    IS NOT NULL)
       OR (purpose='ad_hoc'))

messaging_threads
  id                     uuid PK
  issueId                uuid FK issues UNIQUE
  channelId              uuid FK messaging_channels
  backend                text
  externalThreadRef      text
  parentMessageRef       text
  state                  text          -- 'open' | 'locked'
  createdAt, updatedAt   timestamptz

messaging_identities
  id                     uuid PK
  companyId              uuid FK companies
  agentId                uuid FK agents   NULLABLE
  userId                 uuid FK users    NULLABLE
  backend                text
  externalUserRef        text
  authBlobSecretId       uuid FK company_secrets NULLABLE
  state                  text          -- 'active' | 'pending_auth' | 'revoked'
  inboxPreferences       jsonb NULLABLE
  lastRefreshedAt, createdAt, updatedAt timestamptz
  CHECK ( (agentId IS NOT NULL) <> (userId IS NOT NULL) )
  UNIQUE (backend, externalUserRef)
  UNIQUE (companyId, backend, agentId) WHERE agentId IS NOT NULL
  UNIQUE (companyId, backend, userId)  WHERE userId  IS NOT NULL

messaging_message_refs
  id                     uuid PK       -- stable Paperclip UUID for FKs (feedback, attachments, etc.)
  threadId               uuid FK messaging_threads
  backend                text
  externalMessageRef     text
  authorAgentId          uuid FK agents   NULLABLE
  authorUserId           uuid FK users    NULLABLE
  createdByRunId         uuid FK heartbeat_runs NULLABLE  -- orchestration: which run produced this
  firstSeenAt            timestamptz
  editedAt               timestamptz NULLABLE
  editCount              integer NOT NULL DEFAULT 0
  deletedAt              timestamptz NULLABLE
  suppressedForWake      boolean NOT NULL DEFAULT false   -- replaces "cancel queued comment"
  metadata               jsonb NULLABLE                    -- open-ended audit only
  UNIQUE (backend, externalMessageRef)
  INDEX (threadId, firstSeenAt)
  INDEX (createdByRunId) WHERE createdByRunId IS NOT NULL

messaging_events_inbox             -- webhook idempotency
  id                     uuid PK
  backend                text
  externalEventId        text
  receivedAt             timestamptz
  processedAt            timestamptz NULLABLE
  UNIQUE (backend, externalEventId)

messaging_company_config
  companyId              uuid PK FK companies
  activeBackend          text          -- 'slack' or null (disabled)
  config                 jsonb         -- backend-specific
  updatedAt              timestamptz
```

### Removed tables

- `issue_comments` — dropped. Comment bodies no longer exist in Paperclip.

### Changed FKs

- `issue_attachments.issue_comment_id` → renamed to `messaging_message_ref_id`, FK `messaging_message_refs.id`, `ON DELETE SET NULL` preserved.

### Unchanged

- `approval_comments` stays. Own table, own bodies, separate lifecycle. Phase 2 may move approval chatter into the issue's Slack thread; out of scope for MVP.

### Feedback votes FK shift

`feedback_votes` today targets agent-authored `issue_comments.id`. After migration, the target is `messaging_message_refs.id` — same semantic (vote on an agent-authored message), new target PK. One column rename in the feedback service and schema; no behavioral change for Paperclip-UI voting.

Slack-native reactions on the same message (e.g. 👍 in a thread) are *not* automatically mapped to `feedback_votes` in Phase 1 — reactions land in `messaging_message_refs` as opaque updates. Reaction → feedback bridging is a Phase 1.5 nice-to-have.

### Orchestration metadata semantics

- `createdByRunId`: populated when a post originates from an agent heartbeat. Preserves the existing run-linkage semantic today enforced by `heartbeat.ts` (missing-comment check) and `feedback.ts` (targeting agent-authored runs).
- `suppressedForWake`: replaces today's "cancel queued comment" semantic. With Slack as the record, the message itself stays posted; Paperclip opts out of dispatching wakes for it. The comment-cancel API repurposes to flip this flag.
- `editedAt` / `editCount`: bumped by `events.ts` on inbound `message_changed` events. Bodies are not captured; the ref acts as a durable receipt that an edit happened.
- `deletedAt`: set on inbound `message_deleted` events. Ref row preserved (do not cascade-delete dependent feedback/attachment rows). Listing paths filter out soft-deleted refs by default.

## Core flows

### Agent writes a comment

```
Agent heartbeat → POST /api/issues/:id/comments
  → routes/issues.ts
    → services/issues.ts postComment()
      → messaging.router.postMessage({ issueId, authorAgentId, body, runId })
        1. load messaging_threads row (create via lifecycle if missing)
        2. load author messaging_identities + user token from secret store
        3. adapter.postMessage({ threadRef, channelRef, authorIdentity, body })
             Slack: chat.postMessage (user token), thread_ts=<thread>
             429 → in-memory retry ×3 (2s backoff)
             5xx → in-memory retry ×3 (500ms/1s/2s)
             fail → throw MessagingBackendUnavailable
        4. insert messaging_message_refs row with createdByRunId=<runId>
        5. return { id }
  → 201 Created { id, createdAt }
```

The write does not succeed unless Slack acknowledges. Body is not stored — subsequent reads go live to Slack via the adapter.

### Inbound event (user or agent echo)

```
Slack → POST /api/messaging/slack/events  (signed)
  → adapters/slack/events-webhook.ts
    - verify signing secret (timing-safe, 5-min skew window)
    - Slack URL verification challenge short-circuit
    - dedup via messaging_events_inbox UNIQUE(backend, externalEventId)
    - 200 OK within 3s, process async
  → adapter.normalizeEvent(raw) → MessagingEvent
  → messaging/events.ts handleMessage():
    1. resolve channel + thread via pointer tables; skip if unknown
    2. resolve author via messaging_identities
    3. branch on event kind:
         - new message: upsert messaging_message_refs (idempotent on externalMessageRef)
         - message_changed: set editedAt=now, editCount++
         - message_deleted: set deletedAt=now
         - reaction_added / reaction_removed: update ref (optional reaction summary jsonb)
    4. if ref has suppressedForWake=true → skip wake dispatch
       else parse mentions → fire wakes via issue-assignment-wakeup.ts
         - issue_commented for thread assignee
         - issue_comment_mentioned for each mentioned agent
    5. emit realtime event to UI (existing live-events-ws.ts) — UI fetches body live from Slack
    6. mark messaging_events_inbox.processedAt
```

Wake dispatch is the existing pipeline. Event source changed; semantics unchanged.

### Agent reads a thread

```
Agent heartbeat → GET /api/issues/:id/comments?after=<refId>
  → messaging.router.getThreadMessages({ issueId, afterRefId? })
    1. load recent messaging_message_refs (paginated, ordered firstSeenAt, excludes deleted)
    2. adapter.getThreadMessages(threadRef) — live Slack call
    3. zip bodies onto refs by externalMessageRef
    4. return canonical Message[]
```

**Reads go live to Slack via the adapter.** Paperclip holds no body text. The router returns ref metadata (author, createdByRunId, timestamps) joined with bodies pulled from Slack on each call.

Rate-limit budget: `conversations.replies` is Tier 3 (~50 req/min per method per workspace). For small companies (≤10 agents heartbeating every few minutes), well within quota. If/when pain shows up, a derived index lands as an adapter capability in a later phase and the read path silently switches to index-first with Slack fallback. MVP ships without it.

### Channel / thread lifecycle

- **Channel creation:** lazy on first issue in a project. `adapter.createChannel({ name, purpose: 'project' })`. Name normalization: lowercase, kebab-case, ASCII only, prefixed with `config.channelNamePrefix` (default `'proj-'`), truncated to 80 chars to fit Slack's channel-name limit, collisions resolved by suffixing `-2`, `-3`. Bot auto-joins. Member agents auto-invited via their user tokens.
- **Channel membership (ACL rule):** Paperclip is authoritative. The router invites/removes members based on issue assignments, @-mentions, and project membership. The bot is configured as the channel's sole channel-manager (Slack role) so non-bot users cannot manually invite or kick. Humans who need access are added by the router when Paperclip recognizes them as stakeholders.
- **Thread creation:** lazy on first comment. Bot posts a Block Kit issue-card as the thread parent. `messaging_threads` row recorded.
- **Issue card updates:** on status/assignee/title change, `messaging.router.onIssueStateChange(issue)` → `adapter.editMessage(parentMessageRef, newBlocks)` using the bot token. Fire-and-forget; edit failure logs but does not roll back state.
- **Archive:** Phase 2 (auto-archive on project done). Manual only for Phase 1.
- **Thread lock on `done`/`cancelled`:** soft-locked via `messaging_threads.state = 'locked'`. Events.ts drops messages on locked threads with a polite bot reply; wake dispatch suppressed.

## Identity provisioning

### One-time workspace bot install

Admin initiates in Paperclip UI → Settings → Messaging → Connect Slack workspace.

- Slack OAuth v2 (bot scopes): `channels:read`, `channels:write`, `channels:manage`, `channels:history`, `groups:*`, `im:history`, `chat:write`, `users:read`, `users:read.email`, `reactions:read`, `reactions:write`.
- Callback: `POST /api/messaging/slack/oauth/bot/callback`.
- Persists bot token + signing secret as `company_secrets` rows; creates `messaging_workspace_install` row.
- Signing secret pasted into instance env once at app registration; not returned by OAuth.

### Per-agent user install

Each agent is a real Slack user.

1. **Out-of-band Slack account creation** (manual for MVP): admin creates `agent-name@<paperclip-domain>`, invites email to workspace.
2. **OAuth consent as that user:**
   - Paperclip UI → Agents → `<agent>` → Link to Slack.
   - UI shows "Open this URL while signed into Slack as `agent-name@...`".
   - `/api/messaging/slack/oauth/user/start?agentId=<uuid>` → generates state → redirects to Slack user-scope OAuth.
   - User scopes: `chat:write`, `im:history`, `im:write`, `users:read`, `users.profile:read`, `reactions:write`, `groups:history`.
   - Callback verifies state + that `authed_user.id` is not already bound to another agent.
   - Persists user token as `company_secrets` row; updates `messaging_identities` with `state='active'`.

### Token lifecycle

- Slack tokens long-lived non-refreshing by default. Token rotation opt-in later.
- On `invalid_auth` / `token_revoked`: `messaging_identities.state='revoked'`, UI banner on agent profile. Future `postMessage` calls as that agent error immediately.
- Bot uninstall: whole backend blocked. Banner + re-install required.

### Trust & safety

- Bot and user tokens never leave `company_secrets` storage unencrypted.
- Events webhook verifies Slack signing secret on every request (5-min skew).
- `messaging_events_inbox` dedup prevents double-fire of wakes on Slack retries.
- `X-Paperclip-Run-Id` audit trail flows through router into `messaging_message_refs.metadata`.

## Translation layer

### Mentions

**Outbound (agent post → Slack):** `@claudecoder` in canonical body → resolve via `messaging_identities` → rewritten to `<@U012ABC>` before Slack API call. Unknown names passed through as literal text.

**Inbound (Slack → canonical):** `<@U012ABC>` in Slack event body → reverse-resolve to `@claudecoder` for index/UI storage. Authoritative wake dispatch uses the raw Slack user refs, not the internal form.

### Markdown (GFM ↔ Slack mrkdwn)

**Outbound `mrkdwn.fromGfm`:**
- `**bold**` → `*bold*`
- `*italic*` / `_italic_` → `_italic_`
- Code spans unchanged
- Fenced code blocks: language label dropped
- `- item` / `* item` → `• item`
- `[text](url)` → `<url|text>`
- Tables → plaintext with `|` separators
- Task lists `- [ ]` / `- [x]` → `☐ ` / `☑ `

**Inbound `mrkdwn.toGfm`:** inverse, preserving round-trip fidelity where possible. Slack channel refs `<#C012|name>` → Paperclip internal link form where resolvable.

**Block Kit used for structured content:**
- Issue card (thread parent).
- Approval requests (Phase 1.5 — see Approvals UX).

Normal comments remain text-only (mrkdwn).

### Ticket references

- Outbound: `[PAP-224](/PAP/issues/PAP-224)` → `<https://<paperclip-base>/PAP/issues/PAP-224|PAP-224>`.
- Inbound: regex `[A-Z]{2,}-\d+` validated against issues table, rewritten to Paperclip link form in canonical storage.

### Approvals UX

**MVP (Phase 1):** approvals continue to work via the Paperclip UI exactly as today. When an approval is created, the bot posts a notification to the issue's Slack thread: `⚠ Approval requested — <summary>. Decide in Paperclip: <link>`. No interactive buttons in MVP.

**Phase 1.5:** Block Kit buttons embedded in the approval notification.

```
⚠ Approval requested
<summary, recommended action, risks>
[ Approve ]  [ Deny ]
```

Button click → `POST /api/messaging/slack/interactivity` → signature verified → decision mapped to existing approvals service. Message updated in place with outcome. Follow-up posted to thread. `action_id` encodes `{approvalId, decision}`. Permission check against Paperclip roles before accepting.

**Phase 2:** comment-as-`/approve` fallback and slash commands.

### Attachments

Phase 1 scope — attachments work today in Paperclip, so shipping MVP without them would be a regression.

- **Outbound:** agent comment with an attachment ref → `adapter.postMessageWithFile` → Slack `files.getUploadURLExternal` + `files.completeUploadExternal`. `messaging_message_refs` records the Slack file ID alongside the post. Paperclip blob store remains the canonical store for agent-uploaded bytes (the adapter uploads a copy to Slack for in-thread display).
- **Inbound:** user attaches a file in Slack → events.ts adapter-downloads via user token → stores in Paperclip blob store → registers `issue_attachments` row FK'd to the new `messaging_message_refs.id`.
- **Mixed ownership:** file bytes live in both places (Slack for display, Paperclip for portability/API). Slack is primary for in-thread rendering; Paperclip copy is how `/api/.../attachments/:id/content` continues to serve.

### Issue card

```
┌──────────────────────────────────────────────┐
│ [PAP-224] Fix login timeout                  │   ← header block
│ 🟡 in_progress  ·  assignee @claudecoder     │   ← context block
│ project: Plow  ·  priority: high             │
│ ───                                          │
│ <short description excerpt>                  │   ← section block
│ [ Open in Paperclip ]                        │   ← action button → link
└──────────────────────────────────────────────┘
```

Edits triggered by `messaging.router.onIssueStateChange(issue)` on state changes. Bot token used (bot posted the parent).

### Realtime UI

- `messaging/events.ts` emits the canonical realtime event shape after writing the ref row.
- UI subscribes to the same `issue.comment.created` event; no UI refactor.
- `GET /api/issues/:id/comments` contract unchanged — serves refs from Postgres + bodies live from Slack via adapter.

## `#paperclip-inbox` (per-human digest)

### Topology

Default: bot ↔ user DM opened via `conversations.open`. Appears as "Paperclip" in the user's Slack DM list. Lazily created on first event. Cached as `messaging_channels` row with `purpose='inbox'`, `userId=<user>`.

Optional per-user override: private channel `#paperclip-<username>` with only user + bot as members. Config: `messaging_company_config.config.inbox[userId].mode = 'dm' | 'private_channel'`.

### Content (Phase 1 defaults)

| Event | Default |
|---|---|
| Direct assignment to the user | On |
| Direct `@`-mention in any comment | On |
| Approval requested from the user | On |
| Issue user owns moved to `done`, `blocked`, `in_review` | On |
| Issue user created moved to `done` | On |
| New comment on issue user commented on (watching) | Off (opt-in) |
| New comment on a child of user's issue | Off (opt-in) |

Stored on `messaging_identities.inboxPreferences` jsonb for user-type identities. Managed via `Settings → Messaging → My inbox`.

### Message format

Single Block Kit message per event. No interactive buttons (interactivity lives in the project-channel thread).

```
📥  New assignment
[PAP-224] Fix login timeout
from @cto  ·  priority: high
⟶  Open thread    (deep link: slack://channel?team=T…&id=C…&thread_ts=…)
```

### Noise control

- **Dedup within 2-minute window:** repeat events on the same issue edit the existing inbox message in place ("5 new comments on PAP-224") rather than posting new ones.
- No read-tracking in MVP.
- Digests, quiet hours: Phase 2.

### Identity binding

- Auto-discovery on bot install: bot reads `users.list` with `users:read.email`; for each Paperclip `users` row whose email matches, insert `messaging_identities` row (`userId`, `externalUserRef`, `authBlobSecretId=NULL` — inbox only needs bot→user posting).
- Manual fallback: UI "Link your Slack account" button for users the auto-discovery missed.

### Data shape

- `messaging_channels` row per (companyId, userId) with `purpose='inbox'`.
- A synthetic "inbox meta-thread" per inbox channel holds inbox messages via `messaging_message_refs` (keeps non-nullable `threadId`).
- `messaging_identities.inboxPreferences` jsonb for subscription flags.

### Multi-company

One inbox per company. No cross-company merged inbox in Phase 1.

## Config, errors, telemetry

### Enablement

**Per-instance env / `instance_settings`:** `SLACK_APP_CLIENT_ID`, `SLACK_APP_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_OAUTH_REDIRECT_BASE_URL`.

**Per-company `messaging_company_config`:**
- `activeBackend` — `'slack'` or `null`.
- `config` jsonb — `{ channelNamePrefix: "proj-", inbox: {...} }`.

**UI:**
- `Settings → Messaging` (company-scoped): workspace connect, agent identity status table, channel/inbox naming config.
- Agent profile: Slack link status + re-auth.

### Enforcement

API boundary refuses operations when messaging is not fully configured.

| Condition | Response |
|---|---|
| `activeBackend IS NULL` | 412 `messaging_not_configured` |
| bot not installed | 412 `messaging_not_configured` |
| commenting agent has no active identity | 412 `agent_identity_not_linked` |
| agent identity revoked | 412 `messaging_identity_revoked` |
| thread locked | 409 `messaging_thread_locked` |
| Slack 429 | 429 `messaging_rate_limited` + Retry-After |
| Slack transient failure after retries | 503 `messaging_backend_unavailable` |

No silent fallbacks. Fresh instance requires explicit setup.

### Degraded-mode posture

- In-memory retry only: 3 tries, exponential backoff (500ms / 1s / 2s for 5xx; `Retry-After` for 429).
- Exhausted retries → `MessagingBackendUnavailable` → 503 to caller.
- Agent heartbeat receiving 503 exits cleanly, task stays in prior state, next scheduled heartbeat retries.
- No persistent outbox, no durable queue. "Slack outage = Paperclip comments paused" is the honest posture.

### Telemetry

Reuses existing `telemetry.ts`.

- Counters: `messaging.post.success`, `messaging.post.failure{code}`, `messaging.event.received{kind}`, `messaging.event.dedup_hit`, `messaging.wake.dispatched{reason}`.
- Histograms: `messaging.post.latency_ms`, `messaging.event.process_latency_ms`, `messaging.read.latency_ms`.

### Admin debug endpoints

- `GET /api/messaging/diagnose/:issueId` — thread ref, last 10 message refs, last adapter API status.

## Testing strategy

### FakeAdapter

Lives in `server/src/messaging/adapters/fake/adapter.ts`. Full `MessagingAdapter` interface backed by in-memory state.

- `postMessage` stores locally and synchronously emits an inbound event to `messaging/events.ts` (simulates Slack echo).
- `getThreadMessages` reads from same in-memory state.
- Failure injection: `fakeAdapter.failNextPost('rate_limited')` for retry-path tests.

Local dev default: `activeBackend = 'fake'` with the embedded-postgres dev loop. Slack credentials not required for any development except the Slack adapter itself. Production deployments never route through the fake adapter — it stays scoped to tests/dev by contract, regardless of whether Slack env vars are present.

### Test layers

1. **Unit:** `mrkdwn.fromGfm` / `toGfm` round-trip; `mention-parser` forward/reverse; signing-secret verification; event dedup; capability-flag conditional behavior.
2. **Router integration:** FakeAdapter + real Postgres; write/read/event/wake end-to-end through `services/issues.ts`.
3. **Slack adapter:** against `nock` / `slack-mock` recordings; Slack-specific translation validated without network.
4. **E2E (opt-in, env-gated):** dedicated test Slack workspace + tokens; full write-then-read cycle. Not in CI; `just test:slack-e2e` locally when touching the adapter.

### Migration validation

- `just test` must stay green after the `issue_comments` drop and `issue_attachments` FK rename. No existing test should reference `issueCommentId` after the rename.

## Migration

### Fresh-start mode only (MVP)

- Drop `issue_comments`.
- Rename `issue_attachments.issue_comment_id` → `issue_attachments.messaging_message_ref_id`, FK repointed, data discarded (historical linkage not preserved; fresh start).
- No backfill of existing comments into Slack.
- Operator acknowledges via a one-shot migration gate: CLI prints `This migration drops N comment rows. Proceed? [y/N]`.

Backfill-mode migration (historical comments replayed into Slack threads) explicitly out of scope for MVP.

## Rollout phases

### Phase 1 — MVP (this spec)

- `MessagingAdapter` interface, router, events, registry.
- Slack adapter: bot install, user-token provisioning, text posting, event ingest (new/edit/delete/reaction), wake dispatch, issue-card updates, soft thread lock.
- First-class orchestration columns on `messaging_message_refs`: `createdByRunId`, `editedAt`, `deletedAt`, `suppressedForWake`.
- `feedback_votes` target repointed to `messaging_message_refs.id`.
- Channel-membership rule enforced via Paperclip-only management + bot-as-sole-channel-manager.
- File attachments round-trip (Slack + Paperclip blob store dual-owned).
- FakeAdapter for tests + local dev.
- Fresh-start migration: drop `issue_comments`, rename attachments FK, repoint feedback target.
- UI: Settings → Messaging; agent link status; inbox subscription prefs.
- `#paperclip-inbox` per-user bot DM (default on, six default event types, dedup, auto-discovery identity binding).
- Slack app manifest in repo.
- Approvals: bot posts notification to thread with Paperclip link (no buttons yet).

### Phase 1.5

- Approval buttons in Slack threads (Block Kit interactivity).
- Slack reactions → `feedback_votes` bridging (👍/👎 on agent-authored messages).
- Derived search index as adapter capability (opt-in; rebuildable from Slack).
- Auto-archive project channels when project reaches `done`.
- Per-user inbox private-channel mode.

### Phase 2

- Comment-as-`/approve` fallback; slash commands (e.g. `/paperclip create issue …`).
- Ad-hoc agent↔user group-DM mode (user's original "DM with you CC'd" use case) — creates synthetic issue on first message.
- Daily morning digest + quiet hours (reuses Paperclip routines).
- SCIM / automated agent Slack account provisioning (Enterprise Grid).

### Phase 3 — pluggable backends

- Extract `MessagingAdapter` contract into `@paperclipai/messaging-adapter-sdk` in `packages/`.
- Discord/Matrix/etc. land as community plugins via existing plugin infrastructure.

## Open questions / deferred decisions

- **Token rotation:** start with long-lived non-refreshing tokens. Revisit when Slack deprecates or when agent token count warrants.
- **Approval permissions mapping:** which Paperclip roles can click Approve/Deny from Slack? Default: same permissions the approval API enforces. Specifics deferred to implementation plan.
- **Historical comment archive format:** if an operator wants the dropped `issue_comments` as a one-shot JSON export before the destructive migration, the CLI will offer `paperclipai migrate --archive-comments <path>`. Non-binding; implementation-plan detail.
- **Search** on comment bodies is not available in MVP. `GET /api/companies/:id/issues?q=…` continues to search issue titles/descriptions via SQL; comment-body search returns "not supported" until the Phase 1.5 derived-index capability lands.

## Risks & honest tradeoffs

- **Vendor dependence on Slack** for comm availability. Intentional; matches the "Slack is the record" semantic. Mitigation: adapter abstraction means a future migration to another backend is a provisioning exercise, not a code rewrite.
- **Slack rate limits** on read path. Every `GET /comments` call hits `conversations.replies` live. Tier 3 (~50 req/min per method per workspace) is plenty for MVP-scale instances; a derived-index capability in Phase 1.5 flips the read path to index-first if/when pain shows up.
- **Paid Slack seat per agent** is a real monetary cost. Acceptable at the scale of a personal/small-company instance. For scale-out, Phase 2 SCIM automation keeps linear cost but eliminates manual provisioning friction.
- **Message edits/deletes in Slack are consequences, not audit gaps.** If a human edits or deletes a message in Slack, Paperclip records the timestamp but not the prior content. This matches the "Slack is the tool; if you edit the tool, you deal with the consequence" posture. Acceptable; users who need full audit history should disable edits at the workspace level or use Slack's own retention tools.
- **`approval_comments` stays separate** in Phase 1 — minor UX inconsistency (approvals have their own chatter outside the issue's Slack thread). Acceptable for MVP; addressable in Phase 2 by routing approval comments into the issue's thread.
- **Thread-lock is soft** (not native Slack). A determined user can still type in a locked thread; events.ts will reject with a polite bot reply. Good enough for MVP.

## Summary

This design moves Paperclip's conversational surface into Slack while keeping Paperclip canonical for everything else — issues, approvals, run linkage, wake routing, channel membership. The split is explicit (see **Field ownership** above): Slack owns message bodies, edits, deletes, reactions; Paperclip owns orchestration and issue state. `messaging_message_refs` is the bridge — pointer rows plus first-class orchestration metadata, no body text. MVP reads live from Slack; a derived search index is a later adapter capability if rate-limit pain shows up. The architecture is honest about the tradeoffs — Slack outage means Paperclip comments pause; edits in Slack are consequences, not audit gaps — but it keeps the door open for future backends without forcing a rewrite.
