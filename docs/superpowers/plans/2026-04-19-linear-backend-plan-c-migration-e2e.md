# Linear Backend Migration — Plan C: Plow Migration + End-to-End Smoke

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Plan B's Linear adapter code to wakeup, migrate Sam's Plow Peeps data (SAM → SAI prefix, cancel Slack-era issues, strip Slack identities), walk through the Linear install flow end-to-end (register app, invite agents, OAuth), and run a smoke test that proves the full loop works: human comments in Linear → wake fires on wakeup → agent replies back into Linear.

**Architecture:** Mostly ops + one-off migration SQL. Some steps are **manual user actions** (registering the Linear OAuth app, inviting agents to Linear) — those are clearly marked.

**Predecessor plans:** `plan-a-foundation.md` and `plan-b-adapter.md` must both be landed before Plan C runs.
**Spec:** `docs/superpowers/specs/2026-04-19-linear-backend-migration-design.md`

---

## Context

- **Target host:** wakeup (`ssh odio@wakeup`). Paperclip runs there on port 3100 behind `paperclip-factory.ngrok.app`.
- **Current wakeup DB state:** has `Sam's Plow Peeps` (issue_prefix `SAM`), 5 agents (CEO, CTO, eng-mgr, tech-lead, developer) with Slack identities, SAM-1..9 issues from Slack-era bootstrap.
- **What's retired:** the Slack Paperclip Factory app, Slack identities, Slack webhook install. Slack accounts (sam+ceo, sam+engmgr, so+techlead, sam+eng, sam+cto) stay in the Plow Slack workspace — operator can remove them manually later.
- **What's new:** a Linear workspace (to be created), a Linear OAuth app (to be registered), 5 Linear user accounts for the agents (invited during install), webhook at `https://paperclip-factory.ngrok.app/api/messaging/linear/events`.

## Phase plan

- **Task 1** — User-side preparation (manual)
- **Task 2** — Wakeup preflight: stop server, backup DB
- **Task 3** — Migration SQL: SAM → SAI, cancel SAM-1..9, strip Slack identities
- **Task 4** — Env cleanup: strip SLACK_*, add LINEAR_APP_*
- **Task 5** — Restart wakeup server on Plan A + Plan B code
- **Task 6** — Click through Linear workspace install via UI
- **Task 7** — Invite + OAuth each of 5 agents
- **Task 8** — E2E smoke test
- **Task 9** — Cleanup: retire Slack app, archive channel, remove seats

---

## Task 1: User-side preparation (manual — you do this before anything else)

These are tasks only the user (Sam) can complete. Plan C proper can't proceed until these are done.

- [ ] **Step 1: Create a new Linear workspace**

1. Go to https://linear.app/signup
2. Create a workspace named `Paperclip Factory` (or similar — the name is cosmetic; the team KEY below is what matters)
3. Pick the **Basic** plan tier (sufficient for MVP; Free works but lacks webhook support on some features)

Record:
- Linear workspace slug (e.g. `paperclip-factory`, appears in URL: `linear.app/paperclip-factory/...`)
- The default team's initial state — we'll override its key to `SAI` in step 3 below, or let Paperclip create a new team with that key

- [ ] **Step 2: Register the Paperclip Factory Linear OAuth app**

1. Go to https://linear.app/settings/api/applications
2. Click **New application**
3. Fill in:
   - Name: `Paperclip Factory`
   - Description: `Paperclip agent orchestration platform`
   - Developer URL: `https://paperclip-factory.ngrok.app` (or your domain)
   - Callback URLs:
     ```
     https://paperclip-factory.ngrok.app/api/messaging/linear/oauth/app/callback
     https://paperclip-factory.ngrok.app/api/messaging/linear/oauth/user/callback
     ```
4. Save. Linear generates `Client ID`, `Client Secret`.

Record:
- `LINEAR_APP_CLIENT_ID` (e.g. `ab12cd34ef56...`)
- `LINEAR_APP_CLIENT_SECRET` (e.g. `sk_app_...`)

- [ ] **Step 3: Create the `SAI` team in the Linear workspace**

Option A: let Paperclip auto-create it during the install flow (simpler — Task 6 does this).
Option B: manually pre-create a team with key `SAI` from Linear's Settings → Teams → New team. Paperclip adopts whichever team has `key = SAI`.

Recommended: **Option A**. Less work for you. You only need to do this manually if the Linear workspace already has a team using key `SAI`.

- [ ] **Step 4: Confirm `so@plow.co` is on the Linear workspace**

Sign into Linear with `so@plow.co`. Confirm you're a workspace member. You'll be the "board" user who gives the team direction via Linear.

- [ ] **Step 5: Invite the 5 agent emails (do NOT complete their signup yet)**

From Linear's Settings → Members → Invite:

```
sam+ceo@plow.co        (role: Admin — CEO needs to create labels, projects, etc.)
sam+cto@plow.co        (role: Member)
sam+engmgr@plow.co     (role: Member)
sam+techlead@plow.co   (role: Member)
sam+developer@plow.co  (role: Member)
```

Linear sends invitation emails. **Open each invite email in an incognito window** and accept it into the Linear workspace. You'll log in as each email during Task 7's OAuth flow — so make sure each account is a fully-functional Linear member with a name set.

When done, **ping me to confirm Tasks 1.1–1.5 are complete**. Then I resume with Tasks 2+ autonomously.

---

## Task 2: Wakeup preflight

**Files:** none on the local repo. SSH operations only.

- [ ] **Step 1: SSH + stop the paperclip server**

```bash
ssh odio@wakeup '
  ps aux | grep -E "tsx.*(dev-watch|src/index)" | grep -v grep | awk "{print \$2}" | xargs -r kill
  sleep 3
  lsof -ti:3100
'
```

Expected: port 3100 free.

- [ ] **Step 2: Backup the embedded postgres**

```bash
ssh odio@wakeup '
  mkdir -p ~/.paperclip/instances/default/data/backups
  PGPASSWORD=paperclip pg_dump -h 127.0.0.1 -p 54329 -U paperclip -d paperclip \
    > ~/.paperclip/instances/default/data/backups/pre-linear-$(date +%Y%m%d-%H%M%S).sql
  ls -la ~/.paperclip/instances/default/data/backups/ | tail -5
'
```

Expected: a fresh dump file listed.

---

## Task 3: Migration SQL

**Files:** none — runs SQL against the wakeup postgres directly.

- [ ] **Step 1: Open a psql shell on wakeup**

```bash
ssh odio@wakeup 'PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip'
```

Leave it open in a terminal. The SQL commands below are run inside this shell.

- [ ] **Step 2: Inside psql — change company prefix SAM → SAI**

```sql
BEGIN;
UPDATE companies SET issue_prefix = 'SAI' WHERE issue_prefix = 'SAM';
SELECT id, name, issue_prefix FROM companies WHERE issue_prefix = 'SAI';
COMMIT;
```

Expected: 1 row updated; Sam's Plow Peeps now shows prefix `SAI`.

- [ ] **Step 3: Cancel SAM-1..9 issues with a migration comment**

```sql
BEGIN;
-- Update identifiers from SAM-N to SAI-N for consistency (cosmetic).
UPDATE issues SET identifier = replace(identifier, 'SAM-', 'SAI-')
  WHERE identifier LIKE 'SAM-%';

-- Flip all of them to cancelled with a message explaining the archive.
UPDATE issues
  SET status = 'cancelled', updated_at = NOW()
  WHERE identifier LIKE 'SAI-%'
    AND status NOT IN ('cancelled', 'done');

-- Null out linear_issue_id just in case anything was set.
UPDATE issues SET linear_issue_id = NULL, linear_issue_identifier = NULL
  WHERE identifier LIKE 'SAI-%';

SELECT identifier, status FROM issues WHERE identifier LIKE 'SAI-%' ORDER BY identifier;
COMMIT;
```

Expected: all SAI-1 through SAI-9 showing status=cancelled.

- [ ] **Step 4: Strip Slack-era messaging rows**

```sql
BEGIN;
DELETE FROM messaging_identities WHERE backend = 'slack';
DELETE FROM messaging_workspace_install WHERE backend = 'slack';
-- Clear active_backend so install flow starts clean.
UPDATE messaging_company_config SET active_backend = NULL;
COMMIT;

SELECT (SELECT COUNT(*) FROM messaging_identities) AS identities,
       (SELECT COUNT(*) FROM messaging_workspace_install) AS installs,
       (SELECT active_backend FROM messaging_company_config LIMIT 1) AS active;
```

Expected: all zeros; active backend null.

- [ ] **Step 5: Retire issue_counter reset**

Since Linear will generate new identifiers starting from SAI-1 (overlapping with our archived SAI-1), decide:
- **Option A** (recommended): let Linear start at SAI-1. Old SAI-1 (cancelled) and new SAI-1 (Linear's fresh issue) coexist; Paperclip distinguishes by `linear_issue_id` presence.
- **Option B**: bump `companies.issue_counter` to a safe margin so Linear's first issue becomes SAI-10 or similar. Requires setting `lastIssueNumber` on the Linear team during Task 6 install — Linear team settings expose this.

Default: Option A. No SQL needed.

- [ ] **Step 6: Close psql**

```
\q
```

---

## Task 4: Env cleanup

**Files:** `~/.paperclip/instances/default/.env` on wakeup.

- [ ] **Step 1: Edit the env file**

```bash
ssh odio@wakeup 'cat > ~/.paperclip/instances/default/.env' <<'EOF'
# Paperclip environment variables — wakeup instance, Linear backend
PAPERCLIP_AGENT_JWT_SECRET=<KEEP_EXISTING_VALUE_FROM_BACKUP>

# Linear OAuth app (from Task 1.2)
LINEAR_APP_CLIENT_ID=<FILL_IN>
LINEAR_APP_CLIENT_SECRET=<FILL_IN>

# Public base URL — shared with Slack era
PAPERCLIP_PUBLIC_BASE_URL=https://paperclip-factory.ngrok.app

# Allowed hostnames for the privateHostnameGuard
PAPERCLIP_ALLOWED_HOSTNAMES=paperclip-factory.ngrok.app
EOF
```

Replace `<KEEP_EXISTING_VALUE_FROM_BACKUP>` with the `PAPERCLIP_AGENT_JWT_SECRET` from the previous env contents (check `~/.paperclip/instances/default/.env.bak` if a backup was made during the Slack-era setup, or look at the previous file before overwriting). Replace `<FILL_IN>` with the values from Task 1.2.

- [ ] **Step 2: Verify**

```bash
ssh odio@wakeup 'cat ~/.paperclip/instances/default/.env'
```

Expected: 4 env vars set, no SLACK_* references.

---

## Task 5: Restart wakeup server on Plan A + Plan B code

**Files:** none on local repo — redeploys the branch on wakeup.

- [ ] **Step 1: Pull latest + start dev:watch**

```bash
ssh odio@wakeup '
  export PATH="/home/odio/.npm-global/bin:$PATH"
  cd ~/Hacking/paperclip-factory
  git fetch origin
  git reset --hard origin/feat/linear-backend
  pnpm install 2>&1 | tail -5
  nohup pnpm --filter @paperclipai/server dev:watch > /tmp/paperclip-dev.log 2>&1 &
  disown
  sleep 20
  ss -ltnp | grep :3100 | head -1
  curl -s -o /dev/null -w "health: HTTP %{http_code}\n" http://127.0.0.1:3100/api/health
  curl -s -o /dev/null -w "ngrok: HTTP %{http_code}\n" https://paperclip-factory.ngrok.app/api/health
'
```

Expected: `health: HTTP 200`, `ngrok: HTTP 200`.

- [ ] **Step 2: Verify migrations applied**

```bash
ssh odio@wakeup '
  PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c "
    SELECT COUNT(*) AS tables FROM pg_tables WHERE schemaname=\"public\"
      AND tablename IN (\"issue_comment_refs\", \"messaging_label_refs\", \"issues\");
    SELECT COUNT(*) AS slack_tables FROM pg_tables WHERE schemaname=\"public\"
      AND tablename IN (\"messaging_channels\", \"messaging_threads\", \"messaging_message_refs\");
  "
'
```

Expected: `tables = 3` (all three new tables exist); `slack_tables = 0` (all three Slack-era tables dropped).

---

## Task 6: Linear workspace install via UI

**Files:** none.

- [ ] **Step 1: Open Paperclip UI**

Navigate in browser to https://paperclip-factory.ngrok.app/SAI/company/settings/messaging

Expected state: `readiness: 'disabled'`. UI shows "Connect Linear workspace" button.

- [ ] **Step 2: Click Connect Linear workspace**

This redirects to Linear's OAuth consent page.

- [ ] **Step 3: Sign in as `so@plow.co` and authorize**

You're the admin; Linear shows the consent prompt. Click **Authorize**.

Linear redirects back to Paperclip's callback. Paperclip:
- Exchanges the code for an access token
- Queries or creates the `SAI` team in your Linear workspace
- Resolves the team's workflow state map
- Registers the webhook at `https://paperclip-factory.ngrok.app/api/messaging/linear/events`
- Inserts `messaging_workspace_install` + `messaging_company_config.active_backend = 'linear'`
- Redirects to `/SAI/company/settings/messaging?linear_installed=1`

- [ ] **Step 4: Verify state in DB**

```bash
ssh odio@wakeup '
  PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -x -c "
    SELECT * FROM messaging_workspace_install WHERE backend = \"linear\";
    SELECT * FROM messaging_company_config;
  "
'
```

Expected: a `messaging_workspace_install` row with `backend=linear`, `state=active`, workspace/bot ref set; active_backend = 'linear'.

If UI shows `readiness: 'workflow_mapping_incomplete'`, the Linear team's workflow doesn't have all 6 required states. Add missing states in Linear's team settings, then refresh the Paperclip Settings page.

Expected end state: `readiness: 'agent_identities_incomplete'` (workspace installed, no agents linked yet).

---

## Task 7: Per-agent Linear OAuth

**Files:** none.

- [ ] **Step 1: For each of the 5 agents, complete OAuth**

For `sam+ceo@plow.co` → CEO agent:

1. Open an **incognito window**
2. Sign in to https://linear.app as `sam+ceo@plow.co`
3. In the same incognito window, navigate to Paperclip: `https://paperclip-factory.ngrok.app/SAI/company/settings/messaging`
   - You'll need to log into Paperclip as a board user. If local-trusted mode, this may be automatic; otherwise sign in as `so@plow.co`
4. Click **Link Linear identity** next to CEO → redirects to Linear OAuth
5. Authorize; callback stores the token, creates `messaging_identities` row

Repeat for CTO (`sam+cto@plow.co`), eng-mgr (`sam+engmgr@plow.co`), tech-lead (`sam+techlead@plow.co`), developer (`sam+developer@plow.co`).

- [ ] **Step 2: Verify all 5 identities**

```bash
ssh odio@wakeup '
  PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c "
    SELECT a.name, mi.external_user_ref, mi.state
    FROM messaging_identities mi
    JOIN agents a ON a.id = mi.agent_id
    WHERE mi.backend = \"linear\"
    ORDER BY a.name;
  "
'
```

Expected: 5 rows, all state=active.

- [ ] **Step 3: Verify readiness = ready**

Reload Paperclip Settings → Messaging. Expected: `readiness: 'ready'`, all 5 agents linked.

---

## Task 8: End-to-end smoke test

- [ ] **Step 1: Create an issue in Linear as `so@plow.co`**

In Linear: go to the SAI team, click **New issue**, title _"Say hi in this thread"_. Assign to CEO (via @mention or assignee pick list).

- [ ] **Step 2: Reply in the issue's thread**

Type _"Hey CEO, introduce yourself — who are you and what do you do?"_ as a comment on the issue.

Linear sends a webhook → Paperclip on wakeup → wake CEO.

- [ ] **Step 3: Check the chain on wakeup**

```bash
ssh odio@wakeup '
  PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -x -c "
    SELECT external_event_id, received_at, processed_at FROM messaging_events_inbox
      ORDER BY received_at DESC LIMIT 3;
    SELECT a.name, hr.status, hr.started_at, hr.finished_at
    FROM heartbeat_runs hr JOIN agents a ON a.id = hr.agent_id
    WHERE hr.agent_id = (SELECT id FROM agents WHERE name = \"CEO\")
    ORDER BY hr.created_at DESC LIMIT 3;
  "
'
```

Expected:
- At least one event_id from Linear webhook processed
- A heartbeat_run row for CEO, status=running or succeeded

- [ ] **Step 4: Wait for CEO's reply + verify in Linear**

Watch the issue thread in Linear. CEO should reply via Codex → Linear comment authored by `sam+ceo@plow.co`. May take 1–5 minutes (Codex run).

- [ ] **Step 5: Verify cache-sync landed**

```bash
ssh odio@wakeup '
  PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c "
    SELECT i.identifier, i.status, i.linear_issue_id, a.name AS assignee
    FROM issues i LEFT JOIN agents a ON a.id = i.assignee_agent_id
    WHERE i.linear_issue_id IS NOT NULL
    ORDER BY i.created_at DESC LIMIT 5;
  "
'
```

Expected: at least one issue with linear_issue_id set (the one you just created).

- [ ] **Step 6: Declare end-to-end success**

If CEO replied in Linear AND the wake fired on wakeup AND the cache-sync populated the local issues row → the migration is complete.

---

## Task 9: Slack-side cleanup

Optional but recommended for cleanliness.

- [ ] **Step 1: Delete the Paperclip Factory Slack app**

Go to https://api.slack.com/apps/A0ATWNM06BE → Settings → Basic Information → Delete App.

- [ ] **Step 2: Archive `#proj-plow-dev` in Slack**

In the Plow Slack workspace, archive the channel. Optional — or leave for humans to use for real chat.

- [ ] **Step 3: Remove fake Slack seats**

In the Plow Slack workspace admin, remove `sam-ceo@plow.co`, `sam-engmgr@plow.co`, `so+techlead@plow.co`, `sam-eng@plow.co`, `sam-cto@plow.co` (the ones created specifically for agent identities).

- [ ] **Step 4: Confirm no SLACK_* env vars in wakeup**

```bash
ssh odio@wakeup 'grep -c SLACK ~/.paperclip/instances/default/.env || echo "no slack env vars"'
```

Expected: `no slack env vars`.

---

## Definition of done for Plan C

- [ ] Linear workspace exists; OAuth app registered with correct callback URLs
- [ ] 5 agents (CEO, CTO, eng-mgr, tech-lead, developer) are Linear workspace members with linked Paperclip identities
- [ ] `readiness: 'ready'` in Paperclip admin status endpoint for Sam's Plow Peeps
- [ ] End-to-end smoke: Linear human comment → wake → CEO replies in Linear
- [ ] `pg_dump` backup from Task 2 preserved as pre-migration snapshot
- [ ] Slack Paperclip Factory app deleted (or documented as intentionally retained)
- [ ] `SLACK_*` env vars removed from wakeup's `~/.paperclip/instances/default/.env`
- [ ] Plan A, B, C all landed and pushed to `factory/feat/linear-backend`

---

## Notes for the executor

**Some tasks require user action.** Task 1 (Linear workspace + OAuth app + agent invites) and Task 7 (per-agent OAuth authorization) need the user in the browser. Plan C can't be fully autonomous; the executor coordinates with the user on those.

**Don't run Task 3 (data migration) until Plan A + Plan B are verified passing tests.** If a Plan B defect surfaces only after migration, rollback is `pg_restore` from the Task 2 backup.

**Workflow state mapping may incomplete.** If Linear's default workflow doesn't have `In Review` or `Blocked` states, Task 6 lands with `readiness: 'workflow_mapping_incomplete'`. Add the states in Linear, refresh Paperclip Settings.

**Stale webhooks.** If a previous Linear install left a webhook registered, Paperclip's install in Task 6 may produce a duplicate. Deregister old webhooks manually in Linear's Settings → API → Webhooks if needed.

**Bootstrap a first issue.** Task 8 is the first real work against Linear. Before that, there are no Paperclip-tracked issues in Linear. Create the issue directly in Linear's UI for the smoke test.
