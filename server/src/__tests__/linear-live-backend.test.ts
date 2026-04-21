import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issues as issuesTable, createDb, companies, projects, agents } from "@paperclipai/db";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLinearBackedIssueService } from "../services/linear-backed-issue-service.js";

describe("FakeAdapter — list/search/getByIdentifier", () => {
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
    const issue = await adapter.getIssueByIdentifier("FAKE-1");
    expect(issue).not.toBeNull();
    expect(issue!.title).toBe("My Issue");

    const miss = await adapter.getIssueByIdentifier("FAKE-999");
    expect(miss).toBeNull();
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedSupport.supported ? describe : describe.skip;

describeIf("LinearBackedIssueService", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("linear-svc-");
    db = createDb(tempDb.connectionString);
    cleanup = tempDb.cleanup;
  }, 30_000);

  afterAll(async () => { await cleanup?.(); });

  afterEach(async () => {
    await db.delete(issuesTable);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  async function makeCompany() {
    const [co] = await db.insert(companies)
      .values({ name: "Test Co", issuePrefix: "TST" })
      .returning();
    return co!;
  }

  async function makeAgent(companyId: string) {
    const [ag] = await db.insert(agents)
      .values({ companyId, name: "TestAgent", adapterType: "codex_local" })
      .returning();
    return ag!;
  }

  it("create: creates issue in adapter and inserts sidecar row", async () => {
    const adapter = createFakeAdapter();
    const co = await makeCompany();
    const svc = createLinearBackedIssueService({
      adapter,
      db,
      companyId: co.id,
      externalTeamRef: "team1",
    });

    const result = await svc.create({ title: "New issue" });

    expect(result.title).toBe("New issue");
    expect(result.linearIssueId).toBeTruthy();

    const [row] = await db.select().from(issuesTable)
      .where(eq(issuesTable.linearIssueId, result.linearIssueId!));
    expect(row).toBeTruthy();
    expect(row!.companyId).toBe(co.id);
  });

  it("getById: fetches from adapter and merges sidecar", async () => {
    const adapter = createFakeAdapter();
    const co = await makeCompany();
    const svc = createLinearBackedIssueService({
      adapter,
      db,
      companyId: co.id,
      externalTeamRef: "team1",
    });

    const created = await svc.create({ title: "Fetch me" });
    const fetched = await svc.getById(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Fetch me");
    expect(fetched!.id).toBe(created.id);
  });

  it("list with assigneeAgentId: returns sidecar-matched issues with Linear data", async () => {
    const adapter = createFakeAdapter();
    const co = await makeCompany();
    const ag = await makeAgent(co.id);
    const svc = createLinearBackedIssueService({
      adapter,
      db,
      companyId: co.id,
      externalTeamRef: "team1",
    });

    await svc.create({ title: "Issue A" });
    const b = await svc.create({ title: "Issue B" });
    await svc.update(b.id, { assigneeAgentId: ag.id });

    const agentIssues = await svc.list({ assigneeAgentId: ag.id });
    expect(agentIssues.length).toBe(1);
    expect(agentIssues[0]!.title).toBe("Issue B");
  });

  it("update: syncs core fields to adapter, agent fields to sidecar", async () => {
    const adapter = createFakeAdapter();
    const co = await makeCompany();
    const ag = await makeAgent(co.id);
    const svc = createLinearBackedIssueService({
      adapter,
      db,
      companyId: co.id,
      externalTeamRef: "team1",
    });

    const created = await svc.create({ title: "Original" });
    const updated = await svc.update(created.id, {
      title: "Updated",
      assigneeAgentId: ag.id,
    });

    expect(updated!.title).toBe("Updated");
    expect(updated!.assigneeAgentId).toBe(ag.id);
  });

  it("remove: archives in adapter and makes getById return null", async () => {
    const adapter = createFakeAdapter();
    const co = await makeCompany();
    const svc = createLinearBackedIssueService({
      adapter,
      db,
      companyId: co.id,
      externalTeamRef: "team1",
    });

    const created = await svc.create({ title: "To be removed" });
    expect(await svc.getById(created.id)).not.toBeNull();

    await svc.remove(created.id);

    expect(await svc.getById(created.id)).toBeNull();
  });

  it("getByIdentifier: falls back to adapter when no sidecar row exists", async () => {
    const adapter = createFakeAdapter();
    const co = await makeCompany();
    const svc = createLinearBackedIssueService({
      adapter,
      db,
      companyId: co.id,
      externalTeamRef: "team1",
    });

    // Insert directly into the fake adapter, bypassing svc.create() so no sidecar row is created
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Linear-only issue",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });

    const result = await svc.getByIdentifier("FAKE-1");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Linear-only issue");
    // No sidecar row exists, so id is undefined/null
    expect(result!.id).toBeFalsy();
  });
});
