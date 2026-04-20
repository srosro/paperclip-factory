import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  projects,
  issues,
  agents,
  heartbeatRuns,
  messagingIdentities,
  issueCommentRefs,
} from "@paperclipai/db";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createIssueTrackerRouter } from "../messaging/router.js";
import { MessagingIdentityNotActive } from "../messaging/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

interface Seed {
  companyId: string;
  projectId: string;
  issueId: string;
  linearIssueId: string;
  agentId: string;
}

async function seed(db: ReturnType<typeof createDb>): Promise<Seed> {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({ name: `Co ${suffix}`, issuePrefix: `CO${suffix}` })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ companyId: company!.id, name: `Plow ${suffix}` })
    .returning();
  const linearIssueId = randomUUID();
  const [issue] = await db
    .insert(issues)
    .values({
      companyId: company!.id,
      projectId: project!.id,
      title: "Fix login",
      identifier: `CO${suffix}-1`,
      linearIssueId,
      linearIssueIdentifier: `CO${suffix}-1`,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ companyId: company!.id, name: `alice-${suffix}` })
    .returning();
  return {
    companyId: company!.id,
    projectId: project!.id,
    issueId: issue!.id,
    linearIssueId,
    agentId: agent!.id,
  };
}

describeIf("issue-tracker router", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-router-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueCommentRefs);
    await db.delete(messagingIdentities);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("postComment stores a ref and preserves createdByRunId", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    // Seed the adapter's internal issue so the comment posts cleanly.
    await db
      .update(issues)
      .set({ linearIssueId: (await adapter.createIssue({
        externalTeamRef: "T_1",
        title: "x",
        author: { backend: "fake", externalUserRef: "SYSTEM", credential: { kind: "none" } },
      })).externalIssueRef })
      .where(eq(issues.id, s.issueId));
    const router = createIssueTrackerRouter({ db, adapter, backend: "fake" });

    await db
      .insert(messagingIdentities)
      .values({
        companyId: s.companyId,
        agentId: s.agentId,
        backend: "fake",
        externalUserRef: "U_A",
        state: "active",
      });

    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: s.companyId, agentId: s.agentId })
      .returning();

    const posted = await router.postComment({
      companyId: s.companyId,
      issueId: s.issueId,
      authorAgentId: s.agentId,
      body: "hello",
      createdByRunId: run!.id,
    });

    const [ref] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.id, posted.id));
    expect(ref.createdByRunId).toBe(run!.id);
    expect(ref.authorAgentId).toBe(s.agentId);
  });

  it("falls back to bot_system authoring when no identity is present", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    await db
      .update(issues)
      .set({ linearIssueId: (await adapter.createIssue({
        externalTeamRef: "T_1",
        title: "x",
        author: { backend: "fake", externalUserRef: "SYSTEM", credential: { kind: "none" } },
      })).externalIssueRef })
      .where(eq(issues.id, s.issueId));
    const router = createIssueTrackerRouter({ db, adapter, backend: "fake" });
    // No identity seeded for s.agentId — should succeed anyway, as bot_system.
    await expect(
      router.postComment({
        companyId: s.companyId,
        issueId: s.issueId,
        authorAgentId: s.agentId,
        body: "hello",
      }),
    ).resolves.toBeDefined();
  });

  it("throws MessagingIdentityNotActive when identity is revoked", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    await db
      .update(issues)
      .set({ linearIssueId: (await adapter.createIssue({
        externalTeamRef: "T_1",
        title: "x",
        author: { backend: "fake", externalUserRef: "SYSTEM", credential: { kind: "none" } },
      })).externalIssueRef })
      .where(eq(issues.id, s.issueId));
    const router = createIssueTrackerRouter({ db, adapter, backend: "fake" });
    await db
      .insert(messagingIdentities)
      .values({
        companyId: s.companyId,
        agentId: s.agentId,
        backend: "fake",
        externalUserRef: "U_A",
        state: "revoked",
      });
    await expect(
      router.postComment({
        companyId: s.companyId,
        issueId: s.issueId,
        authorAgentId: s.agentId,
        body: "hi",
      }),
    ).rejects.toBeInstanceOf(MessagingIdentityNotActive);
  });

  it("syncIssueToExternal — idempotent: returns existing ref without calling createIssue", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    // adapter has no issues yet — createIssue would add one
    const issueCountBefore = adapter.state.issuesByRef.size;
    const router = createIssueTrackerRouter({ db, adapter, backend: "fake" });

    const result = await router.syncIssueToExternal(s.issueId);

    expect(result.externalIssueRef).toBe(s.linearIssueId);
    // No call to adapter.createIssue
    expect(adapter.state.issuesByRef.size).toBe(issueCountBefore);
  });

  it("syncIssueToExternal — mint: creates external issue and persists linearIssueId", async () => {
    const s = await seed(db);
    // Clear linearIssueId so the mint path fires
    await db
      .update(issues)
      .set({ linearIssueId: null, linearIssueIdentifier: null })
      .where(eq(issues.id, s.issueId));

    const adapter = createFakeAdapter();
    const router = createIssueTrackerRouter({ db, adapter, backend: "fake" });

    const result = await router.syncIssueToExternal(s.issueId);

    // Adapter was called and returned a new ref
    expect(result.externalIssueRef).toBeTruthy();
    expect(adapter.state.issuesByRef.has(result.externalIssueRef)).toBe(true);

    // DB row updated
    const [row] = await db.select().from(issues).where(eq(issues.id, s.issueId)).limit(1);
    expect(row!.linearIssueId).toBe(result.externalIssueRef);

    // Returned value matches DB
    expect(result.externalIssueRef).toBe(row!.linearIssueId);
  });

  it("getComments returns refs zipped with live adapter bodies", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    const liveIssue = await adapter.createIssue({
      externalTeamRef: "T_1",
      title: "x",
      author: { backend: "fake", externalUserRef: "SYSTEM", credential: { kind: "none" } },
    });
    await db
      .update(issues)
      .set({ linearIssueId: liveIssue.externalIssueRef })
      .where(eq(issues.id, s.issueId));
    const router = createIssueTrackerRouter({ db, adapter, backend: "fake" });

    const first = await router.postComment({
      companyId: s.companyId,
      issueId: s.issueId,
      body: "alpha",
    });
    const second = await router.postComment({
      companyId: s.companyId,
      issueId: s.issueId,
      body: "beta",
    });

    const comments = await router.getComments({ issueId: s.issueId });
    expect(comments.map((c) => c.refId).sort()).toEqual([first.id, second.id].sort());
    expect(comments.map((c) => c.body).sort()).toEqual(["alpha", "beta"]);
  });
});
