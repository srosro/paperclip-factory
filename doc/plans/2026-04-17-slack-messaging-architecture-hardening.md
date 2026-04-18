# Slack Messaging Architecture Hardening Plan

Date: 2026-04-17
Status: Draft
Branch reviewed: `feat/slack-first-comms`
Baseline reviewed against: merge-base `b9a80dcf226c50c8778a70443e41557980376a03`

## Purpose

Improve the Slack-first messaging architecture without backing away from the core product premise:

- Slack is the canonical communication surface.
- Slack outage means comments are unavailable. That is acceptable.
- Paperclip should not store duplicate message bodies as a backup.
- The architecture should stay DRY: one canonical side-effect path, one canonical source of truth for message bodies, one canonical company-scoped messaging context.

This plan is about fixing the places where the current implementation does not yet support that premise cleanly.

## Review Summary

The branch has a strong product direction. Making Slack the real company communication layer is coherent with Paperclip's "synthetic company using real company tools" premise.

The current implementation is not ready to carry that premise safely yet. The main issues are not "Slack is critical" or "Slack has no backup." Those tradeoffs are acceptable. The real problems are:

1. The runtime is still process-global when it needs to be company-scoped.
2. Slack references are modeled too loosely for a multi-company, multi-workspace control plane.
3. Side effects are split between route code and event code, so Slack-originated messages do not drive the same wake behavior as API-originated messages.
4. A few existing Paperclip flows still assume local comments and break under Slack-first execution.

## Concrete Findings

### 1. Process-global backend selection breaks company scoping

Current behavior:

- `server/src/app.ts:137-160` switches the entire server to backend `"slack"` whenever Slack env vars are present.
- `server/src/messaging/index.ts:77-160` stores a single global `currentBackend`, single global router, and a Slack adapter optionally pinned to exactly one company.
- `server/src/messaging/index.ts:95-113` pins Slack to one company only when there is exactly one install; otherwise the adapter has no company scope and later throws.

Why this matters:

- If Slack env is configured but a company has not installed Slack yet, comment writes still route into the Slack backend.
- If there is more than one company install, the adapter loses company scope entirely.
- The branch introduces `messaging_company_config`, but the runtime does not actually resolve backend/config per company.

This violates Paperclip's company-scoped invariant and makes multi-company behavior unreliable.

### 2. External Slack references are not modeled at the right identity boundary

Current behavior:

- `packages/db/src/schema/messaging_message_refs.ts:26-29` treats `(backend, externalMessageRef)` as globally unique.
- `packages/db/src/schema/messaging_identities.ts:29-32` treats `(backend, externalUserRef)` as globally unique.
- `packages/db/src/schema/messaging_channels.ts:30-33` treats `(backend, externalChannelRef)` as globally unique.
- `server/src/messaging/events.ts:186-247` resolves edits, deletes, and reactions by `externalMessageRef` alone.
- `server/src/messaging/events.ts:264-289` resolves threads and identities by external ref alone.
- `server/src/messaging/adapters/slack/adapter.ts:330-355` and `:389-397` already show that Slack addresses a message by `channel + ts`, not `ts` alone.

Why this matters:

- For Slack, message identity is not just the timestamp string. The API itself requires channel context.
- Thread identity is also channel-relative.
- User identity is workspace-relative.

The current schema and lookup paths are therefore too weak for a real multi-workspace deployment. Even before future backends, the Slack-first model needs workspace-aware and channel-aware natural keys.

### 3. Inbound Slack messages do not drive Paperclip wake semantics

Current behavior:

- The design doc says events should drive wake dispatch for assignee and mentioned agents.
- `server/src/messaging/events.ts:162-179` exposes `mentionedAgentIds` and `mentionedUserIds` to `onMessageCreated`.
- `server/src/app.ts:149-160` only uses that callback for inbox DM notifications to mentioned users.

What is missing:

- No assignee wake on inbound Slack comment.
- No mentioned-agent wake on inbound Slack comment.

Why this matters:

- A user talking to an issue thread directly in Slack is supposed to be using the canonical company communication surface.
- Right now, route-originated comments still wake agents via `server/src/routes/issues.ts:2436-2528`, but Slack-originated comments do not.

This is the biggest product-behavior gap in the branch.

### 4. "Cancel queued comment" semantics diverge from the Slack-authoritative model

Current behavior:

- The design doc says queued-comment cancellation should flip `suppressedForWake` and keep the Slack message visible.
- `server/src/services/issues.ts:2288-2299` soft-deletes the ref by setting `deletedAt`.
- `server/src/routes/issues.ts:2173-2236` still exposes this as canceling a queued comment.

Why this matters:

- Slack remains visible, but Paperclip hides the message locally.
- That creates split-brain behavior: the Slack thread still contains the instruction, while Paperclip acts as if it disappeared.
- It also does not use the new orchestration field that was introduced for exactly this purpose.

If Slack is canonical, the message should remain canonical. Cancellation should suppress side effects, not erase local visibility.

### 5. System-authored comments are incompatible with the Slack adapter

Current behavior:

- `server/src/messaging/router.ts:346-355` creates a synthetic `SYSTEM` identity with credential kind `"none"`.
- `server/src/messaging/adapters/slack/adapter.ts:183-191` rejects anything except user token or bot token.
- `server/src/services/heartbeat.ts:2990-3005` calls `issuesSvc.addComment(..., {})` during stranded-issue escalation, which becomes a system-authored comment.

Why this matters:

- Existing Paperclip recovery flows now rely on a comment path that Slack cannot execute.
- This will fail exactly in operational scenarios where the system is trying to explain a recovery/escalation decision.

Slack-first does not remove the need for host-authored comments. It just means they should post as the bot/system principal, not as a fake author with no credential.

## Recommendation

Merge direction: salvage the Slack-first product direction, but do not treat the current implementation as the long-term architecture.

The right next move is not to add a local backup store or a second messaging plane. The right next move is to tighten the architecture around a few hard rules:

1. Company-scoped messaging context
2. Workspace-aware and channel-aware external identity modeling
3. One side-effect pipeline for message-driven behavior
4. Explicit host/system posting semantics
5. Slack-first, no-backup posture documented and enforced honestly

## Target Architecture

### Rule 1: Slack stays canonical for message bodies

- `messaging_message_refs` remains a pointer and orchestration table.
- No local body mirror.
- Reads continue to fetch live from Slack.
- No outbox, no durable replay queue, no offline backup.

### Rule 2: Messaging context resolves per company, not per process

Each request or workflow that touches messaging should resolve a `MessagingContext` from company-scoped state:

- company id
- enabled backend (`slack` or disabled)
- workspace install
- adapter/token resolvers
- capability flags

The runtime should stop depending on a process-global `currentBackend`.

### Rule 3: Natural keys must match how Slack actually identifies things

For Slack:

- workspace install is first-class
- channel identity is workspace + channel
- user identity is workspace + user
- thread identity is channel + thread ts
- message identity is channel + message ts

Paperclip can still keep UUID primary keys, but the natural-key uniqueness must match Slack's addressing model.

### Rule 4: Message side effects should be DRY

There should be one canonical service that handles message-driven side effects:

- wake assignee
- wake mentioned agents
- inbox DM notifications
- attachment ingest
- suppression checks
- live-event fanout

The same service should run for:

- Slack-originated inbound events
- Paperclip-originated posts after Slack acknowledges them
- Fake-adapter local echo in tests

The logic should not be split between route handlers and unrelated app bootstrap closures.

### Rule 5: Host/system posts should be explicit

Paperclip needs a first-class "bot/system principal" for comments it authors itself:

- issue recovery explanations
- thread-locked replies
- issue card posts and updates
- future approval/status automation

Those should use the workspace bot token, not a fake `"SYSTEM"` user with no credential.

## Detailed Task Breakdown

## Track 1: Lock the product stance and delete accidental ambiguity

### Task 1.1: Freeze Phase 1 scope around Slack-first, not backend-pluggable-at-runtime

Outcome:

- Paperclip remains architecturally capable of future backends.
- Production Phase 1 behavior is explicitly "Slack or disabled per company."
- `fake` becomes a test/dev adapter, not a production routing mode.

Work:

- Update the design doc and this plan to say:
  - Slack is the only production backend in Phase 1.
  - `fake` exists for tests/dev only.
  - no local message-body backup will be added.

Acceptance:

- No code path in production chooses `fake` because Slack env vars are missing.
- No doc implies a hidden backup or fallback message store.

### Task 1.2: Decide whether `messaging_company_config` stays or is deferred

Preferred direction:

- Keep it, but narrow it to:
  - `activeBackend = 'slack' | null`
  - lightweight per-company messaging config only

Work:

- Either wire it into runtime resolution immediately or remove it from Phase 1 until the resolver lands.
- Do not leave it as dead schema.

Acceptance:

- There is exactly one authoritative per-company enable/disable source.

## Track 2: Replace process-global messaging state with company-scoped resolution

### Task 2.1: Introduce `resolveMessagingContext(companyId)`

Outcome:

- Messaging operations become company-scoped.

Work:

- Add a small resolver service, for example:
  - `server/src/messaging/context.ts`
- It should:
  - load `messaging_company_config` and `messaging_workspace_install`
  - return disabled/not-configured explicitly
  - construct the Slack adapter with the correct company/workspace scope

Acceptance:

- `issues`, `heartbeat`, `feedback`, and Slack routes can request a messaging context by company id.
- No global `currentBackend` is needed for normal request handling.

### Task 2.2: Remove process-global backend selection from app bootstrap

Work:

- Replace `server/src/app.ts:137-160` startup backend switch.
- Keep only:
  - adapter registration
  - shared helpers
  - event processor bootstrap that can resolve company-aware context

Acceptance:

- Starting the server with Slack env vars no longer forces every company onto Slack automatically.

### Task 2.3: Use `MessagingNotConfigured` consistently

Work:

- When a company has no active Slack install, writes should fail with the existing typed error, not with generic adapter exceptions.
- Reads should degrade honestly:
  - either empty thread for uninitialized companies
  - or a typed 412/feature-disabled response, depending on endpoint semantics

Acceptance:

- The user sees "messaging not configured for this company", not "Slack adapter requires companyId".

## Track 3: Fix Slack natural-key modeling

### Task 3.1: Add explicit workspace linkage to all Slack-backed messaging tables

Preferred shape:

- `messaging_channels.workspace_install_id`
- `messaging_identities.workspace_install_id`
- `messaging_threads.workspace_install_id` or indirect resolution via channel
- `messaging_message_refs.channel_id` retained via thread join, but natural key must include channel context

Acceptance:

- Every Slack ref row can be traced unambiguously to one workspace install.

### Task 3.2: Strengthen uniqueness constraints

Required changes:

- Channels: unique on `(workspace_install_id, external_channel_ref)`
- Identities: unique on `(workspace_install_id, external_user_ref)`
- Threads: unique on `(channel_id, external_thread_ref)` or equivalent
- Messages: unique on `(channel_id, external_message_ref)` or equivalent

Acceptance:

- The schema no longer assumes backend-wide uniqueness for Slack identifiers.

### Task 3.3: Rewrite event lookups to use workspace/channel-aware keys

Work:

- `events.ts`
  - resolve channel by workspace + channel ref
  - resolve thread by channel + thread ref
  - resolve message ref by channel + message ref
  - resolve identity by workspace + external user ref

Acceptance:

- Edit/delete/reaction handling no longer updates rows based on message ts alone.

### Task 3.4: Backfill migration strategy

Work:

- Because this branch has not shipped broadly yet, prefer a forward-only corrective migration.
- Populate workspace linkage from existing company/workspace install rows.
- Rebuild indexes before relying on new lookups.

Acceptance:

- Existing branch databases migrate without manual SQL edits.

## Track 4: Make message side effects DRY

### Task 4.1: Introduce a single `handleMessageCreatedSideEffects(...)` service

Responsibilities:

- skip if `suppressedForWake`
- resolve assignee
- wake assignee on `issue_commented`
- wake mentioned agents on `issue_comment_mentioned`
- dispatch inbox DMs for mentioned users
- trigger any live-event/UI invalidation hook

Non-responsibilities:

- body storage
- business logic outside message-driven reactions

Acceptance:

- One service owns the message-created side effects regardless of origin.

### Task 4.2: Route inbound Slack events through that service

Work:

- Extend current `onMessageCreated` usage so it handles:
  - `mentionedAgentIds`
  - `mentionedUserIds`
  - assignee wake

Acceptance:

- A human comment typed directly in Slack wakes the assigned agent.
- A Slack `@mention` of an agent wakes that agent.

### Task 4.3: Route Paperclip-authored posts through the same service

Problem to solve:

- Route-originated posts currently wake agents in `routes/issues.ts`.
- Slack-originated posts currently do not.

Preferred direction:

- Remove message-side-effect logic from the issue route.
- After Slack acknowledges the post and the ref exists, invoke the same side-effect service once.
- Keep idempotency so a later webhook echo does not double-fire.

Possible implementation options:

- Option A: outbound posts call side-effect service immediately and persist a processed marker on the ref.
- Option B: outbound posts rely on synthetic local ingestion that reuses the exact same event path.

Acceptance:

- There is one wake/inbox decision path for new messages.
- No duplicate wakes for the same comment.

### Task 4.4: Keep FakeAdapter exercising the same pipeline

Work:

- Preserve local echo in tests/dev.
- Ensure fake echo still reaches the same side-effect service as Slack events.

Acceptance:

- Messaging tests remain realistic without splitting behavior by adapter.

## Track 5: Fix cancel/delete semantics

### Task 5.1: Re-implement queued-comment cancellation as suppression, not deletion

Work:

- Replace the current `deletedAt` update in `issues.ts` comment-cancel flow with:
  - `suppressedForWake = true`
  - optional metadata marker for auditability

Acceptance:

- The comment remains visible because Slack is canonical.
- Paperclip stops treating it as a wake source.

### Task 5.2: Separate "suppress side effects" from "delete from Slack"

Work:

- Keep queued-comment cancel focused on suppression.
- If real message deletion is needed later, add a separate explicit admin/author delete flow that calls Slack and then records `deletedAt` from the authoritative event.

Acceptance:

- Paperclip no longer hides a Slack-visible comment under the name of queue cancellation.

## Track 6: Add a first-class host/system principal

### Task 6.1: Introduce `authorKind = agent | user | bot_system`

Work:

- Refactor router author resolution so host-authored posts can intentionally use the bot token.
- Do not overload missing author ids into a fake `"SYSTEM"` user ref with no credential.

Acceptance:

- System-authored comments can post through Slack successfully.

### Task 6.2: Convert existing system comment paths

Initial callers:

- stranded issue escalation in `heartbeat.ts`
- locked-thread polite replies
- any future recovery/status automation

Acceptance:

- No production system path depends on a comment author with credential kind `"none"`.

## Track 7: Tighten routing and provisioning behavior

### Task 7.1: Make channel creation and membership explicitly company/workspace-scoped

Work:

- `router.ts` should resolve the correct workspace install before channel creation.
- Membership operations should use identities tied to the same workspace install.

Acceptance:

- Cross-company or cross-workspace membership mistakes are structurally impossible.

### Task 7.2: Decide how ad-hoc issue channels behave in Slack Phase 1

Current code creates ad-hoc channels for issues without projects.

Decision needed:

- keep this behavior and scope it cleanly
- or require project-backed issues before Slack thread creation

Recommendation:

- keep it for now, but make the naming and lifecycle explicit in docs/admin tools

## Track 8: Align admin/UI behavior with actual runtime state

### Task 8.1: Settings page should reflect real company messaging state

Work:

- Show:
  - disabled
  - Slack not installed
  - Slack installed but agent identities incomplete
  - ready

Acceptance:

- UI matches runtime truth, not just presence of a workspace row.

### Task 8.2: Add operator diagnostics for context resolution

Work:

- Extend the existing diagnose route to include:
  - resolved backend
  - workspace install id
  - channel natural key
  - whether the latest comment side effects were suppressed/processed

Acceptance:

- Operators can debug misrouting without reading the database directly.

## Track 9: Expand test coverage around the actual architectural risks

### Task 9.1: Add multi-company Slack tests

Coverage:

- two companies with Slack installed
- per-company routing
- per-company identity resolution
- per-company event ingestion

Acceptance:

- A comment or event in company A cannot touch company B state.

### Task 9.2: Add cross-channel message-ref tests

Coverage:

- same `ts` in different channels
- edit/delete/reaction events only update the intended row

Acceptance:

- Message lookup keys prove channel-aware correctness.

### Task 9.3: Add inbound Slack wake tests

Coverage:

- inbound Slack comment wakes assignee
- inbound Slack agent mention wakes mentioned agent
- inbound Slack user mention sends inbox DM
- suppressed ref does not fire side effects

Acceptance:

- Slack-originated communication actually drives the control plane.

### Task 9.4: Add system/bot comment tests

Coverage:

- host-authored recovery comment posts through Slack
- issue reconciliation does not fail on system comment path

Acceptance:

- Operational automations stay functional under Slack-first messaging.

### Task 9.5: Add cancel-queued-comment behavior tests

Coverage:

- cancellation flips suppression
- comment still appears in live Slack reads
- wake side effects are skipped

Acceptance:

- Comment cancel semantics match the declared Slack-authoritative model.

## Suggested Delivery Order

1. Track 1: freeze scope and remove ambiguity
2. Track 2: per-company messaging context
3. Track 3: workspace/channel-aware keys
4. Track 6: host/system principal
5. Track 4: unified side-effect service
6. Track 5: cancel/delete semantics
7. Track 8: admin/UI truthfulness
8. Track 9: expanded tests

## Merge Gate For The Next Iteration

The next architecture pass should not be considered complete until all are true:

- backend resolution is company-scoped, not process-global
- Slack identifiers are modeled with the right natural keys
- inbound Slack comments wake assignees and mentioned agents
- queued-comment cancellation uses suppression rather than local deletion
- system-authored comments can post through the bot principal
- targeted multi-company and cross-channel tests exist

## Explicit Non-Goals

These are intentionally not part of this hardening plan:

- storing Slack message bodies locally as backup
- introducing a durable outbox or replay queue
- building a second messaging system alongside Slack
- making Slack optional for companies that have already chosen to use Slack messaging
- expanding to Discord/Matrix before the Slack-first architecture is structurally correct
