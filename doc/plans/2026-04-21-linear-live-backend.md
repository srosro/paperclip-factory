# Linear Live Backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Paperclip's Postgres `issues` table as the read/write backend with the Linear API. All issue reads go live to Linear; the local DB is a thin agent-metadata sidecar only. Clean-slate migration — drop all issue-related tables, keep users and Linear auth.

**Architecture:** The `IssueTrackerAdapter` (already exists) is extended with list/search methods. A new `LinearBackedIssueService` replaces the current DB-backed `IssueService` — routes call the same method names, different implementation underneath. Writes go to Linear first; sidecar gets agent metadata (assigneeAgentId, executionPolicy, workProducts, checkouts). Agent heartbeat queries sidecar for `linearIssueId`s, then batch-fetches from Linear for current status. `cache-sync.ts` is gutted to side-effects only (no issue data writes).

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, Linear GraphQL API

**Prerequisite:** `feat/linear-backend` branch with the Phase 1 plan fully implemented (all 6 tasks committed).

---

## Data Model

### Sidecar `issues` table (after migration)

Only 6 columns are dropped. Everything else is Paperclip-internal and stays.

**Drop (Linear owns these):**
`title`, `description`, `status`, `priority`, `identifier`, `issueNumber`

**Keep (Paperclip-internal):**

| Column | Notes |
|--------|-------|
| `id`, `companyId` | Core identity |
| `linearIssueId`, `linearIssueIdentifier` | Link to Linear |
| `projectId`, `goalId`, `parentId` | Paperclip hierarchy |
| `assigneeAgentId`, `assigneeUserId` | Agent/user assignment |
| `checkoutRunId`, `executionRunId` | FK → heartbeat_runs |
| `executionAgentNameKey`, `executionLockedAt` | Execution state |
| `executionPolicy`, `executionState` | Agent config |
| `executionWorkspaceId`, `projectWorkspaceId` | Workspaces |
| `executionWorkspacePreference`, `executionWorkspaceSettings` | Workspace config |
| `createdByAgentId`, `createdByUserId` | Audit |
| `originKind`, `originId`, `originRunId`, `requestDepth` | Origin tracking |
| `billingCode`, `assigneeAdapterOverrides` | Billing / overrides |
| `startedAt`, `completedAt`, `cancelledAt`, `hiddenAt` | Timing |
| `createdAt`, `updatedAt` | Timestamps |

**Indexes to drop/update:**
- Drop `issues_identifier_idx` (unique on `identifier`)
- Drop `issues_company_status_idx`, `issues_company_assignee_status_idx`, `issues_company_assignee_user_status_idx` (reference `status`)
- Drop `issues_title_search_idx`, `issues_description_search_idx`, `issues_identifier_search_idx` (GIN indexes on dropped columns)
- Update `issues_open_routine_execution_uq` partial index — remove the `status IN (...)` predicate since `status` is dropped

**Tables dropped entirely:** none — the existing related tables (`issue_labels`, etc.) reference `issues.id` which stays. The clean slate just means no valuable data to migrate, not a schema overhaul.

---

## File Map

| File | Change |
|------|--------|
| `server/src/messaging/adapters/linear/graphql.ts` | Add `QUERY_ISSUES`, `QUERY_ISSUES_BY_ASSIGNEE`, `QUERY_ISSUE_SEARCH` |
| `server/src/messaging/types.ts` | Add `listIssues`, `searchIssues`, `getIssueByIdentifier` to `IssueTrackerAdapter` |
| `server/src/messaging/adapters/linear/adapter.ts` | Implement the three new methods |
| `server/src/messaging/adapters/fake/adapter.ts` | Implement the three new methods |
| `server/src/services/linear-backed-issue-service.ts` | New: service that reads/writes via adapter, joins sidecar |
| `server/src/messaging/router.ts` | Expose `listIssues`, `searchIssues`, `getIssueByIdentifier` on router |
| `server/src/routes/issues.ts` | Swap `IssueService` for `LinearBackedIssueService` throughout |
| `server/src/routes/agents.ts` | Update heartbeat to use sidecar + Linear for assigned-issue lookup |
| `server/src/messaging/adapters/linear/cache-sync.ts` | Remove issue upsert/update; keep side-effect handlers only |
| `packages/db/src/migrations/XXXX_linear_live_sidecar.sql` | New migration: drop dead columns/tables, create slim sidecar |
| `packages/db/src/schema/issues.ts` | Update schema to match sidecar-only columns |

---

### Task 1: Extend adapter interface with list/search/getByIdentifier

Add three new methods to `IssueTrackerAdapter` in `types.ts` and implement them in both the Linear adapter and the fake adapter.

**Files:**
- Modify: `server/src/messaging/types.ts`
- Modify: `server/src/messaging/adapters/linear/graphql.ts`
- Modify: `server/src/messaging/adapters/linear/adapter.ts`
- Modify: `server/src/messaging/adapters/fake/adapter.ts`
- Test: `server/src/__tests__/linear-live-backend.test.ts`

- [ ] **Step 1: Write failing tests for the three new adapter methods**

Create `server/src/__tests__/linear-live-backend.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";

describe("IssueTrackerAdapter — list/search/getByIdentifier", () => {
  it("listIssues returns issues filtered by assignee", async () => {
    const adapter = createFakeAdapter();
    const { externalIssueRef: ref1 } = await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Alpha",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Beta",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    const all = await adapter.listIssues({ externalTeamRef: "team1" });
    expect(all.length).toBe(2);

    // update first issue to have an assignee
    await adapter.updateIssue({
      externalIssueRef: ref1,
      assigneeExternalRef: "u1",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    const assigned = await adapter.listIssues({
      externalTeamRef: "team1",
      assigneeExternalRef: "u1",
    });
    expect(assigned.length).toBe(1);
    expect(assigned[0]!.externalIssueRef).toBe(ref1);
  });

  it("searchIssues returns issues matching query", async () => {
    const adapter = createFakeAdapter();
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Fix the login bug",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Add dashboard chart",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    const results = await adapter.searchIssues({ externalTeamRef: "team1", query: "login" });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain("login");
  });

  it("getIssueByIdentifier returns the matching issue", async () => {
    const adapter = createFakeAdapter();
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "My Issue",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    // fake adapter uses FAKE-1 as identifier
    const issue = await adapter.getIssueByIdentifier("FAKE-1");
    expect(issue).not.toBeNull();
    expect(issue!.title).toBe("My Issue");

    const miss = await adapter.getIssueByIdentifier("FAKE-999");
    expect(miss).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm -w exec vitest run server/src/__tests__/linear-live-backend.test.ts
```

Expected: FAIL — `adapter.listIssues is not a function`.

- [ ] **Step 3: Add the three methods to `IssueTrackerAdapter` in `types.ts`**

In `server/src/messaging/types.ts`, find the `IssueTrackerAdapter` interface and add after `getComment`:

```typescript
/** List issues, optionally filtered by team, assignee, state. */
listIssues(opts: {
  externalTeamRef?: ExternalRef;
  assigneeExternalRef?: ExternalRef | null;
  stateExternalRef?: ExternalRef | null;
  limit?: number;
  afterExternalRef?: ExternalRef;
}): Promise<Issue[]>;

/** Full-text search within a team's issues. */
searchIssues(opts: {
  externalTeamRef?: ExternalRef;
  query: string;
  limit?: number;
}): Promise<Issue[]>;

/** Resolve an identifier like "PLO-5" to a full Issue, or null if not found. */
getIssueByIdentifier(identifier: string): Promise<Issue | null>;
```

- [ ] **Step 4: Add GraphQL queries to `graphql.ts`**

In `server/src/messaging/adapters/linear/graphql.ts`, append:

```typescript
export const QUERY_ISSUES = `
  query Issues(
    $teamId: ID
    $assigneeId: ID
    $stateId: ID
    $first: Int
    $after: String
  ) {
    issues(
      filter: {
        team: { id: { eq: $teamId } }
        assignee: { id: { eq: $assigneeId } }
        state: { id: { eq: $stateId } }
      }
      first: $first
      after: $after
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        state { id name type }
        assignee { id name email }
        labels { nodes { id name color } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const QUERY_ISSUE_SEARCH = `
  query IssueSearch($teamId: ID, $query: String!, $first: Int) {
    issueSearch(
      query: $query
      filter: { team: { id: { eq: $teamId } } }
      first: $first
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        state { id name type }
        assignee { id name email }
        labels { nodes { id name color } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const QUERY_ISSUE_BY_IDENTIFIER = `
  query IssueByIdentifier($identifier: String!) {
    issueByIdentifier(identifier: $identifier) {
      id
      identifier
      title
      description
      priority
      state { id name type }
      assignee { id name email }
      labels { nodes { id name color } }
      createdAt
      updatedAt
    }
  }
`;
```

- [ ] **Step 5: Implement the three methods in the Linear adapter**

In `server/src/messaging/adapters/linear/adapter.ts`, add after `getComment`:

```typescript
async listIssues(opts) {
  const client = await workspaceClient();
  const res = await client.request<{
    issues: { nodes: LinearIssueRaw[] };
  }>(QUERY_ISSUES, {
    teamId: opts.externalTeamRef ?? null,
    assigneeId: opts.assigneeExternalRef ?? null,
    stateId: opts.stateExternalRef ?? null,
    first: opts.limit ?? 50,
    after: opts.afterExternalRef ?? null,
  });
  return (res.issues.nodes ?? []).map(rawToIssue);
},

async searchIssues(opts) {
  const client = await workspaceClient();
  const res = await client.request<{
    issueSearch: { nodes: LinearIssueRaw[] };
  }>(QUERY_ISSUE_SEARCH, {
    teamId: opts.externalTeamRef ?? null,
    query: opts.query,
    first: opts.limit ?? 50,
  });
  return (res.issueSearch.nodes ?? []).map(rawToIssue);
},

async getIssueByIdentifier(identifier) {
  const client = await workspaceClient();
  const res = await client.request<{
    issueByIdentifier: LinearIssueRaw | null;
  }>(QUERY_ISSUE_BY_IDENTIFIER, { identifier });
  return res.issueByIdentifier ? rawToIssue(res.issueByIdentifier) : null;
},
```

Add the new query constants to the import at the top of `adapter.ts`:

```typescript
import {
  // ... existing imports ...
  QUERY_ISSUES,
  QUERY_ISSUE_SEARCH,
  QUERY_ISSUE_BY_IDENTIFIER,
} from "./graphql.js";
```

- [ ] **Step 6: Implement the three methods in the fake adapter**

In `server/src/messaging/adapters/fake/adapter.ts`, add after `getComment`:

```typescript
async listIssues(opts) {
  let results = [...issuesByRef.values()];
  if (opts.externalTeamRef !== undefined) {
    // fake adapter has no team concept — return all
  }
  if (opts.assigneeExternalRef !== undefined) {
    results = results.filter(
      (i) => i.assigneeExternalRef === opts.assigneeExternalRef,
    );
  }
  if (opts.stateExternalRef !== undefined) {
    results = results.filter(
      (i) => i.stateExternalRef === opts.stateExternalRef,
    );
  }
  const limit = opts.limit ?? 50;
  return results.slice(0, limit).map((i) => ({ ...i }));
},

async searchIssues(opts) {
  const q = opts.query.toLowerCase();
  const results = [...issuesByRef.values()].filter(
    (i) => i.title.toLowerCase().includes(q) ||
            (i.description ?? "").toLowerCase().includes(q),
  );
  return results.slice(0, opts.limit ?? 50).map((i) => ({ ...i }));
},

async getIssueByIdentifier(identifier) {
  const found = [...issuesByRef.values()].find(
    (i) => i.identifier === identifier,
  );
  return found ? { ...found } : null;
},
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
pnpm -w exec vitest run server/src/__tests__/linear-live-backend.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run full test suite**

```bash
pnpm -w run test
```

Expected: same pass count as before (3 pre-existing failures only).

- [ ] **Step 9: Typecheck**

```bash
pnpm --filter @paperclipai/server exec tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git -C /Users/so/Hacking/paperclip add \
  server/src/messaging/types.ts \
  server/src/messaging/adapters/linear/graphql.ts \
  server/src/messaging/adapters/linear/adapter.ts \
  server/src/messaging/adapters/fake/adapter.ts \
  server/src/__tests__/linear-live-backend.test.ts
git -C /Users/so/Hacking/paperclip commit -m "feat(adapter): listIssues / searchIssues / getIssueByIdentifier on adapter interface"
```

---

### Task 2: Expose list/search/getByIdentifier on the messaging router

The messaging router (`router.ts`) wraps the adapter and adds the sidecar join. Extend it with the three new read methods so routes can call them without touching the adapter directly.

**Files:**
- Modify: `server/src/messaging/router.ts`
- Modify: `server/src/messaging/types.ts` (router interface)

- [ ] **Step 1: Add the three methods to `IssueTrackerRouter` in `types.ts`**

Find the `IssueTrackerRouter` interface and add:

```typescript
listIssues(opts: {
  externalTeamRef?: ExternalRef;
  assigneeExternalRef?: ExternalRef | null;
  limit?: number;
}): Promise<Issue[]>;

searchIssues(opts: {
  externalTeamRef?: ExternalRef;
  query: string;
  limit?: number;
}): Promise<Issue[]>;

getIssueByIdentifier(identifier: string): Promise<Issue | null>;
```

- [ ] **Step 2: Implement on the router in `router.ts`**

In the object returned by `createIssueTrackerRouter`, add:

```typescript
async listIssues(opts) {
  return adapter.listIssues(opts);
},

async searchIssues(opts) {
  return adapter.searchIssues(opts);
},

async getIssueByIdentifier(identifier) {
  return adapter.getIssueByIdentifier(identifier);
},
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/server exec tsc --noEmit
```

Fix any errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/so/Hacking/paperclip add \
  server/src/messaging/router.ts \
  server/src/messaging/types.ts
git -C /Users/so/Hacking/paperclip commit -m "feat(router): expose listIssues / searchIssues / getIssueByIdentifier on messaging router"
```

---

### Task 3: DB migration — slim sidecar schema

Drop the columns and tables that Linear now owns. Recreate the `issues` table with only sidecar columns. This is a clean-slate migration: there is no valuable data in the existing tables.

**Files:**
- Modify: `packages/db/src/schema/issues.ts`
- Create: new migration via `pnpm drizzle-kit generate`

- [ ] **Step 1: Update `packages/db/src/schema/issues.ts`**

Remove the 6 dropped columns and update the indexes. The existing file is at `packages/db/src/schema/issues.ts`. Remove these column definitions:
- `title: text("title").notNull()`
- `description: text("description")`
- `status: text("status").notNull().default("backlog")`
- `priority: text("priority").notNull().default("medium")`
- `identifier: text("identifier")`
- `issueNumber: integer("issue_number")`

Remove these index definitions from the table config:
- `identifierIdx: uniqueIndex("issues_identifier_idx").on(table.identifier)`
- `companyStatusIdx: index("issues_company_status_idx").on(table.companyId, table.status)`
- `assigneeStatusIdx: index("issues_company_assignee_status_idx").on(...)`
- `assigneeUserStatusIdx: index("issues_company_assignee_user_status_idx").on(...)`
- `titleSearchIdx: index("issues_title_search_idx").using(...)`
- `identifierSearchIdx: index("issues_identifier_search_idx").using(...)`
- `descriptionSearchIdx: index("issues_description_search_idx").using(...)`

Update the `openRoutineExecutionIdx` partial index — remove the `and ${table.status} in (...)` predicate since `status` is dropped:

```typescript
openRoutineExecutionIdx: uniqueIndex("issues_open_routine_execution_uq")
  .on(table.companyId, table.originKind, table.originId)
  .where(
    sql`${table.originKind} = 'routine_execution'
      and ${table.originId} is not null
      and ${table.hiddenAt} is null
      and ${table.executionRunId} is not null`,
  ),
```

Also remove the `integer` import if `issueNumber` was the only integer column.

- [ ] **Step 3: Generate the migration**

```bash
pnpm --filter @paperclipai/db exec drizzle-kit generate
```

Review the generated SQL. It should show `DROP COLUMN` for the removed columns and `DROP TABLE` for removed tables.

- [ ] **Step 4: Apply the migration locally**

```bash
pnpm --filter @paperclipai/db exec drizzle-kit migrate
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/db exec tsc --noEmit
```

Fix any compile errors caused by references to dropped columns (e.g. `issues.title`, `issues.status`). These will be addressed in Task 4; for now just note them.

- [ ] **Step 6: Commit**

```bash
git -C /Users/so/Hacking/paperclip add \
  packages/db/src/schema/issues.ts \
  packages/db/src/migrations/
git -C /Users/so/Hacking/paperclip commit -m "feat(db): slim issues table to sidecar-only columns; drop Linear-owned fields"
```

---

### Task 4: LinearBackedIssueService — reads from Linear, writes sidecar

Create a new service class that implements the same interface as the current `IssueService` but delegates reads to the Linear adapter and writes to both Linear and the sidecar.

**Files:**
- Create: `server/src/services/linear-backed-issue-service.ts`
- Test: `server/src/__tests__/linear-live-backend.test.ts`

- [ ] **Step 1: Write failing tests for the new service**

Add to `server/src/__tests__/linear-live-backend.test.ts`:

```typescript
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createLinearBackedIssueService } from "../services/linear-backed-issue-service.js";

describe("LinearBackedIssueService", () => {
  it("create: inserts sidecar row and returns merged issue", async () => {
    const adapter = createFakeAdapter();
    const svc = createLinearBackedIssueService({
      adapter,
      db,         // from the outer describeIf block
      companyId: "test-company",
      externalTeamRef: "team1",
      workspaceToken: "tok",
    });

    const result = await svc.create({
      title: "New issue",
      companyId: "test-company",
    });

    expect(result.title).toBe("New issue");
    expect(result.linearIssueId).toBeTruthy();

    // sidecar row exists
    const [row] = await db.select().from(issuesTable)
      .where(eq(issuesTable.linearIssueId, result.linearIssueId!));
    expect(row).toBeTruthy();
  });

  it("getById: fetches from Linear and merges sidecar", async () => {
    const adapter = createFakeAdapter();
    const svc = createLinearBackedIssueService({
      adapter, db, companyId: "test-company", externalTeamRef: "team1", workspaceToken: "tok",
    });

    const created = await svc.create({ title: "Fetch me", companyId: "test-company" });
    const fetched = await svc.getById(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Fetch me");
    expect(fetched!.id).toBe(created.id);
  });

  it("list: returns issues from adapter filtered by assignee agent", async () => {
    const adapter = createFakeAdapter();
    const svc = createLinearBackedIssueService({
      adapter, db, companyId: "test-company", externalTeamRef: "team1", workspaceToken: "tok",
    });

    await svc.create({ title: "Issue A", companyId: "test-company" });
    const b = await svc.create({ title: "Issue B", companyId: "test-company", assigneeAgentId: "agent-1" });
    await svc.update(b.id, { assigneeAgentId: "agent-1" });

    const agentIssues = await svc.list({ companyId: "test-company", assigneeAgentId: "agent-1" });
    expect(agentIssues.length).toBe(1);
    expect(agentIssues[0]!.title).toBe("Issue B");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm -w exec vitest run server/src/__tests__/linear-live-backend.test.ts
```

Expected: FAIL — `createLinearBackedIssueService` not found.

- [ ] **Step 3: Create `server/src/services/linear-backed-issue-service.ts`**

```typescript
import { eq } from "drizzle-orm";
import { issues as issuesTable } from "@paperclipai/db";
import type { IssueTrackerAdapter, Issue } from "../messaging/types.js";
import type { Db } from "../router.js";

export interface LinearBackedIssueServiceDeps {
  adapter: IssueTrackerAdapter;
  db: Db;
  companyId: string;
  externalTeamRef: string;
  /** Linear user ref to use for system-level mutations (bot token identity). */
  systemUserRef?: string;
}

export interface LinearBackedIssue extends Issue {
  /** Paperclip-internal UUID (the sidecar row id). */
  id: string;
  companyId: string;
  linearIssueId: string | null;
  linearIssueIdentifier: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: unknown | null;
  workProducts: unknown | null;
  goalId: string | null;
  projectId: string | null;
  hiddenAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

type CreateArgs = {
  title: string;
  description?: string | null;
  companyId: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  executionPolicy?: unknown;
  goalId?: string | null;
  projectId?: string | null;
  stateExternalRef?: string | null;
  priority?: number | null;
};

type UpdateArgs = {
  title?: string | null;
  description?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  executionPolicy?: unknown;
  workProducts?: unknown;
  stateExternalRef?: string | null;
  priority?: number | null;
  hiddenAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
};

type ListOpts = {
  companyId: string;
  assigneeAgentId?: string | null;
  limit?: number;
};

const SYSTEM_AUTHOR = (userRef: string) => ({
  externalUserRef: userRef,
  credential: { kind: "none" as const },
});

export function createLinearBackedIssueService(deps: LinearBackedIssueServiceDeps) {
  const { adapter, db, companyId, externalTeamRef } = deps;
  const systemRef = deps.systemUserRef ?? "system";

  async function mergeSidecar(
    linearIssue: Issue,
    sidecar: typeof issuesTable.$inferSelect | null,
  ): Promise<LinearBackedIssue> {
    return {
      ...linearIssue,
      id: sidecar?.id ?? "",
      companyId,
      linearIssueId: sidecar?.linearIssueId ?? linearIssue.externalIssueRef,
      linearIssueIdentifier: sidecar?.linearIssueIdentifier ?? linearIssue.identifier,
      assigneeAgentId: sidecar?.assigneeAgentId ?? null,
      assigneeUserId: sidecar?.assigneeUserId ?? null,
      executionPolicy: sidecar?.executionPolicy ?? null,
      workProducts: sidecar?.workProducts ?? null,
      goalId: sidecar?.goalId ?? null,
      projectId: sidecar?.projectId ?? null,
      hiddenAt: sidecar?.hiddenAt ?? null,
      startedAt: sidecar?.startedAt ?? null,
      completedAt: sidecar?.completedAt ?? null,
      cancelledAt: sidecar?.cancelledAt ?? null,
    };
  }

  async function getSidecarByLinearId(linearIssueId: string) {
    const [row] = await db
      .select()
      .from(issuesTable)
      .where(eq(issuesTable.linearIssueId, linearIssueId))
      .limit(1);
    return row ?? null;
  }

  async function getSidecarById(id: string) {
    const [row] = await db
      .select()
      .from(issuesTable)
      .where(eq(issuesTable.id, id))
      .limit(1);
    return row ?? null;
  }

  return {
    async create(args: CreateArgs): Promise<LinearBackedIssue> {
      const ref = await adapter.createIssue({
        externalTeamRef,
        title: args.title,
        description: args.description ?? undefined,
        stateExternalRef: args.stateExternalRef ?? undefined,
        priority: args.priority ?? undefined,
        author: SYSTEM_AUTHOR(systemRef),
      });

      const [sidecar] = await db
        .insert(issuesTable)
        .values({
          companyId,
          linearIssueId: ref.externalIssueRef,
          linearIssueIdentifier: ref.identifier,
          assigneeAgentId: args.assigneeAgentId ?? null,
          assigneeUserId: args.assigneeUserId ?? null,
          executionPolicy: args.executionPolicy ?? null,
          goalId: args.goalId ?? null,
          projectId: args.projectId ?? null,
        })
        .returning();

      const linearIssue = await adapter.getIssue(ref.externalIssueRef);
      return mergeSidecar(linearIssue!, sidecar!);
    },

    async getById(id: string): Promise<LinearBackedIssue | null> {
      const sidecar = await getSidecarById(id);
      if (!sidecar?.linearIssueId) return null;
      const linearIssue = await adapter.getIssue(sidecar.linearIssueId);
      if (!linearIssue) return null;
      return mergeSidecar(linearIssue, sidecar);
    },

    async getByLinearId(linearIssueId: string): Promise<LinearBackedIssue | null> {
      const linearIssue = await adapter.getIssue(linearIssueId);
      if (!linearIssue) return null;
      const sidecar = await getSidecarByLinearId(linearIssueId);
      return mergeSidecar(linearIssue, sidecar);
    },

    async getByIdentifier(identifier: string): Promise<LinearBackedIssue | null> {
      // First check sidecar for the identifier (fast path, no API call for lookup)
      const [sidecarRow] = await db
        .select()
        .from(issuesTable)
        .where(eq(issuesTable.linearIssueIdentifier, identifier))
        .limit(1);

      if (sidecarRow?.linearIssueId) {
        const linearIssue = await adapter.getIssue(sidecarRow.linearIssueId);
        if (!linearIssue) return null;
        return mergeSidecar(linearIssue, sidecarRow);
      }
      // Fallback: ask Linear directly
      const linearIssue = await adapter.getIssueByIdentifier(identifier);
      if (!linearIssue) return null;
      const sidecar = await getSidecarByLinearId(linearIssue.externalIssueRef);
      return mergeSidecar(linearIssue, sidecar);
    },

    async list(opts: ListOpts): Promise<LinearBackedIssue[]> {
      // If filtering by agent, resolve their Linear user ref via sidecar first
      let assigneeExternalRef: string | null | undefined;
      if (opts.assigneeAgentId !== undefined) {
        if (opts.assigneeAgentId === null) {
          assigneeExternalRef = null;
        } else {
          // Look up the agent's Linear identity from sidecar rows
          const sidecars = await db
            .select()
            .from(issuesTable)
            .where(eq(issuesTable.assigneeAgentId, opts.assigneeAgentId))
            .limit(opts.limit ?? 50);
          // Fetch all their linear issues directly
          const linearIssues = await Promise.all(
            sidecars
              .filter((s) => s.linearIssueId)
              .map((s) => adapter.getIssue(s.linearIssueId!)),
          );
          return linearIssues
            .filter((i): i is Issue => i !== null)
            .map((linearIssue) => {
              const sidecar = sidecars.find(
                (s) => s.linearIssueId === linearIssue.externalIssueRef,
              ) ?? null;
              return {
                ...linearIssue,
                id: sidecar?.id ?? "",
                companyId,
                linearIssueId: sidecar?.linearIssueId ?? null,
                linearIssueIdentifier: sidecar?.linearIssueIdentifier ?? null,
                assigneeAgentId: sidecar?.assigneeAgentId ?? null,
                assigneeUserId: sidecar?.assigneeUserId ?? null,
                executionPolicy: sidecar?.executionPolicy ?? null,
                workProducts: sidecar?.workProducts ?? null,
                goalId: sidecar?.goalId ?? null,
                projectId: sidecar?.projectId ?? null,
                hiddenAt: sidecar?.hiddenAt ?? null,
                startedAt: sidecar?.startedAt ?? null,
                completedAt: sidecar?.completedAt ?? null,
                cancelledAt: sidecar?.cancelledAt ?? null,
              };
            });
        }
      }

      const linearIssues = await adapter.listIssues({
        externalTeamRef,
        assigneeExternalRef,
        limit: opts.limit ?? 50,
      });

      return Promise.all(
        linearIssues.map(async (linearIssue) => {
          const sidecar = await getSidecarByLinearId(linearIssue.externalIssueRef);
          return mergeSidecar(linearIssue, sidecar);
        }),
      );
    },

    async update(id: string, args: UpdateArgs): Promise<LinearBackedIssue | null> {
      const sidecar = await getSidecarById(id);
      if (!sidecar?.linearIssueId) return null;

      // Core Linear fields → adapter
      const hasLinearUpdate =
        args.title !== undefined ||
        args.description !== undefined ||
        args.stateExternalRef !== undefined ||
        args.priority !== undefined;

      if (hasLinearUpdate) {
        await adapter.updateIssue({
          externalIssueRef: sidecar.linearIssueId,
          title: args.title,
          description: args.description,
          stateExternalRef: args.stateExternalRef,
          priority: args.priority,
          author: SYSTEM_AUTHOR(systemRef),
        });
      }

      // Agent-only fields → sidecar
      const sidecarPatch: Partial<typeof issuesTable.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (args.assigneeAgentId !== undefined) sidecarPatch.assigneeAgentId = args.assigneeAgentId;
      if (args.assigneeUserId !== undefined) sidecarPatch.assigneeUserId = args.assigneeUserId;
      if (args.executionPolicy !== undefined) sidecarPatch.executionPolicy = args.executionPolicy;
      if (args.workProducts !== undefined) sidecarPatch.workProducts = args.workProducts;
      if (args.hiddenAt !== undefined) sidecarPatch.hiddenAt = args.hiddenAt;
      if (args.startedAt !== undefined) sidecarPatch.startedAt = args.startedAt;
      if (args.completedAt !== undefined) sidecarPatch.completedAt = args.completedAt;
      if (args.cancelledAt !== undefined) sidecarPatch.cancelledAt = args.cancelledAt;

      await db.update(issuesTable).set(sidecarPatch).where(eq(issuesTable.id, id));

      return this.getById(id);
    },

    async remove(id: string): Promise<void> {
      const sidecar = await getSidecarById(id);
      if (sidecar?.linearIssueId) {
        await adapter.archiveIssue(sidecar.linearIssueId);
      }
      await db.delete(issuesTable).where(eq(issuesTable.id, id));
    },

    async getComments(id: string) {
      const sidecar = await getSidecarById(id);
      if (!sidecar?.linearIssueId) return [];
      return adapter.getComments(sidecar.linearIssueId);
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm -w exec vitest run server/src/__tests__/linear-live-backend.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @paperclipai/server exec tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git -C /Users/so/Hacking/paperclip add \
  server/src/services/linear-backed-issue-service.ts \
  server/src/__tests__/linear-live-backend.test.ts
git -C /Users/so/Hacking/paperclip commit -m "feat(services): LinearBackedIssueService — live reads from Linear, sidecar for agent metadata"
```

---

### Task 5: Swap routes to use LinearBackedIssueService

Update `routes/issues.ts` to use `LinearBackedIssueService` instead of the current DB-backed `IssueService`. Routes call the same method names; the implementation underneath changes.

**Files:**
- Modify: `server/src/routes/issues.ts`

This is the largest task. The routes file is 2800 lines and references `issues.title`, `issues.status`, `issues.description`, `issues.priority`, etc. extensively. After Task 3's migration those columns are gone from the DB, so the TypeScript compiler will flag every reference. Work through each error.

- [ ] **Step 1: Replace the service instantiation**

At the top of `issues.ts` where `IssueService` is constructed (or injected), replace it with `createLinearBackedIssueService`. You will need:
- The messaging context (for the adapter and externalTeamRef)
- The db
- The companyId

Because `LinearBackedIssueService` needs the adapter, it must be created per-request (or per-company) inside the route handler, after the messaging context is resolved. Alternatively, create a factory function that takes `messagingCtx` and returns the service. Choose whichever is less disruptive to the existing route structure.

- [ ] **Step 2: Fix all type errors from dropped columns**

```bash
pnpm --filter @paperclipai/server exec tsc --noEmit 2>&1 | head -60
```

Work through each error. Common patterns:
- `issue.title` → comes from `LinearBackedIssue.title` (inherited from `Issue`)
- `issue.status` → read from Linear's `stateExternalRef` mapped through workflow state map, or from the `LinearBackedIssue` merged object
- `issue.identifier` → use `issue.linearIssueIdentifier`
- `issues.identifier` (Drizzle column reference in queries) → use `issues.linearIssueIdentifier`

For any query that used to `SELECT ... FROM issues WHERE identifier = $1`, replace with `WHERE linearIssueIdentifier = $1`.

- [ ] **Step 3: Fix route that resolves issue by identifier**

The middleware around line 573 resolves `PLO-5` style identifiers to UUIDs:

```typescript
// Old:
const byIdentifier = await db.select().from(issues)
  .where(eq(issues.identifier, maybeIdentifier)).limit(1);

// New:
const byIdentifier = await db.select().from(issues)
  .where(eq(issues.linearIssueIdentifier, maybeIdentifier)).limit(1);
```

- [ ] **Step 4: Remove `syncIssueToExternal` calls**

Now that creation goes directly to Linear via `LinearBackedIssueService.create`, remove the post-create `messagingCtx.router.syncIssueToExternal(issue.id)` call (it would double-create in Linear). The compensating `svc.remove` on failure also goes away.

- [ ] **Step 5: Run tests**

```bash
pnpm -w run test
```

Fix any failures.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @paperclipai/server exec tsc --noEmit
```

Must be clean.

- [ ] **Step 7: Commit**

```bash
git -C /Users/so/Hacking/paperclip add server/src/routes/issues.ts
git -C /Users/so/Hacking/paperclip commit -m "feat(routes): swap IssueService for LinearBackedIssueService throughout"
```

---

### Task 6: Update agent heartbeat to use sidecar + Linear

The heartbeat (`POST /agents/:id/heartbeat/invoke`) currently queries `issues WHERE assigneeAgentId = agentId AND status IN (...)`. After the migration, `status` is gone from the sidecar. Update it to query the sidecar for assigned `linearIssueId`s and then filter by status from Linear.

**Files:**
- Modify: `server/src/routes/agents.ts` (or wherever the heartbeat handler lives)

- [ ] **Step 1: Locate the heartbeat query**

```bash
grep -n "heartbeat\|assigneeAgentId.*status\|status.*assigneeAgentId" \
  server/src/routes/agents.ts | head -20
```

- [ ] **Step 2: Replace the DB status query with a sidecar + Linear lookup**

Old pattern (approximate):
```typescript
const assignedIssues = await db.select().from(issues)
  .where(
    and(
      eq(issues.assigneeAgentId, agentId),
      inArray(issues.status, ["todo", "in_progress"]),
    ),
  );
```

New pattern:
```typescript
// Step 1: get all linearIssueIds assigned to this agent
const sidecars = await db.select().from(issues)
  .where(eq(issues.assigneeAgentId, agentId));

// Step 2: fetch current status from Linear for each
const liveIssues = await Promise.all(
  sidecars
    .filter((s) => s.linearIssueId)
    .map((s) => linearSvc.getByLinearId(s.linearIssueId!)),
);

// Step 3: filter by active status
const activeIssues = liveIssues.filter(
  (i) => i !== null && ["todo", "in_progress"].includes(i.status ?? ""),
);
```

Where `linearSvc` is a `LinearBackedIssueService` instance for this company. The messaging context must be resolved to get the adapter; wrap with a try/catch so a missing Linear config degrades gracefully (agent sees no issues, not a 500).

- [ ] **Step 3: Run tests**

```bash
pnpm -w run test
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @paperclipai/server exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/so/Hacking/paperclip add server/src/routes/agents.ts
git -C /Users/so/Hacking/paperclip commit -m "feat(heartbeat): query sidecar + Linear for agent-assigned issues"
```

---

### Task 7: Gut cache-sync to side-effects only

`cache-sync.ts` was needed when the local DB was the read source. Now that reads go to Linear, the issue upsert/update handlers are dead code. Keep only the side-effect handlers (label sync, or any webhook-triggered wakeup logic).

**Files:**
- Modify: `server/src/messaging/adapters/linear/cache-sync.ts`

- [ ] **Step 1: Delete issue upsert and update functions**

Remove `upsertIssueFromEvent`, `updateIssueFromEvent`, `markIssueCancelled`.

In `syncFromLinearEvent`, remove the `case "issue_created"`, `case "issue_updated"`, `case "issue_assignee_changed"`, and `case "issue_removed"` branches.

Keep only `case "labels_changed"` (and any other non-issue-data side effects).

- [ ] **Step 2: Run tests**

```bash
pnpm -w run test
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/server exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/so/Hacking/paperclip add \
  server/src/messaging/adapters/linear/cache-sync.ts
git -C /Users/so/Hacking/paperclip commit -m "chore(cache-sync): remove issue data sync; webhooks handle side-effects only"
```

---

## Final sweep

- [ ] `pnpm -w run test` — all pass (modulo the 3 pre-existing failures)
- [ ] `pnpm --filter @paperclipai/server exec tsc --noEmit` — clean
- [ ] Apply migration on MBA: `ssh samuelodio@samuels-macbook-air.tail3b4d58.ts.net "cd ~/Plow/paperclip && git pull && pnpm --filter @paperclipai/db exec drizzle-kit migrate"`
- [ ] Restart server on MBA (tsx auto-reloads on file changes after pull)
- [ ] Smoke test:
  1. Create an issue via Paperclip API — it appears in Linear within seconds
  2. Update title in Linear — GET /issues/:id returns the new title immediately (live read)
  3. Agent heartbeat — agent sees its assigned issues
  4. Create issue directly in Linear — it's visible via Paperclip API once a sidecar row exists (or via `getByIdentifier`)
- [ ] Push to factory remote: `git -C /Users/so/Hacking/paperclip push factory feat/linear-backend`
