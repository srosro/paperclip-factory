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
  messagingChannels,
  messagingThreads,
  messagingIdentities,
  messagingMessageRefs,
} from "@paperclipai/db";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createMessagingRegistry } from "../messaging/registry.js";
import { createMessagingRouter } from "../messaging/router.js";
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
    .values({
      companyId: company!.id,
      name: `Plow ${suffix}`,
    })
    .returning();
  const [issue] = await db
    .insert(issues)
    .values({
      companyId: company!.id,
      projectId: project!.id,
      title: "Fix login",
      identifier: `CO${suffix}-1`,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: `alice-${suffix}`,
    })
    .returning();
  return {
    companyId: company!.id,
    projectId: project!.id,
    issueId: issue!.id,
    agentId: agent!.id,
  };
}

describeIf("messaging router", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-messaging-router-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(messagingMessageRefs);
    await db.delete(messagingThreads);
    await db.delete(messagingIdentities);
    await db.delete(messagingChannels);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("getOrCreateChannel is idempotent and slugs project names", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    const registry = createMessagingRegistry();
    registry.register(adapter);
    const router = createMessagingRouter({ db, registry, backend: "fake" });

    const a = await router.getOrCreateChannel({ companyId: s.companyId, projectId: s.projectId });
    const b = await router.getOrCreateChannel({ companyId: s.companyId, projectId: s.projectId });
    expect(a.id).toBe(b.id);

    const rows = await db
      .select()
      .from(messagingChannels)
      .where(eq(messagingChannels.projectId, s.projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalChannelName).toMatch(/^proj-/);
  });

  it("getOrCreateThread posts an issue card once per issue", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    const registry = createMessagingRegistry();
    registry.register(adapter);
    const router = createMessagingRouter({ db, registry, backend: "fake" });

    const a = await router.getOrCreateThread({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
    });
    const b = await router.getOrCreateThread({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
    });
    expect(a.id).toBe(b.id);

    const rows = await db
      .select()
      .from(messagingThreads)
      .where(eq(messagingThreads.issueId, s.issueId));
    expect(rows).toHaveLength(1);
  });

  it("postMessage stores a ref with createdByRunId preserved", async () => {
    const s = await seed(db);
    await db.insert(messagingIdentities).values({
      companyId: s.companyId,
      agentId: s.agentId,
      backend: "fake",
      externalUserRef: "U_alice",
      state: "active",
    });

    const adapter = createFakeAdapter();
    const registry = createMessagingRegistry();
    registry.register(adapter);
    const router = createMessagingRouter({ db, registry, backend: "fake" });

    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: s.companyId, agentId: s.agentId })
      .returning();

    const posted = await router.postMessage({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
      authorAgentId: s.agentId,
      body: "hello",
      createdByRunId: run!.id,
    });

    const [row] = await db
      .select()
      .from(messagingMessageRefs)
      .where(eq(messagingMessageRefs.id, posted.id));
    expect(row!.createdByRunId).toBe(run!.id);
    expect(row!.authorAgentId).toBe(s.agentId);
  });

  it("postMessage throws MessagingIdentityNotActive when identity is missing", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    const registry = createMessagingRegistry();
    registry.register(adapter);
    const router = createMessagingRouter({ db, registry, backend: "fake" });

    await expect(
      router.postMessage({
        companyId: s.companyId,
        issueId: s.issueId,
        projectId: s.projectId,
        authorAgentId: s.agentId,
        body: "no identity",
      }),
    ).rejects.toBeInstanceOf(MessagingIdentityNotActive);
  });

  it("getThreadMessages returns refs zipped with live adapter bodies", async () => {
    const s = await seed(db);
    await db.insert(messagingIdentities).values({
      companyId: s.companyId,
      agentId: s.agentId,
      backend: "fake",
      externalUserRef: "U_alice",
      state: "active",
    });

    const adapter = createFakeAdapter();
    const registry = createMessagingRegistry();
    registry.register(adapter);
    const router = createMessagingRouter({ db, registry, backend: "fake" });

    const postArgs = {
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
      authorAgentId: s.agentId,
    };
    await router.postMessage({ ...postArgs, body: "first" });
    await router.postMessage({ ...postArgs, body: "second" });

    const messages = await router.getThreadMessages({ issueId: s.issueId });
    expect(messages.map((m) => m.body)).toEqual(["first", "second"]);
    expect(messages.every((m) => m.authorAgentId === s.agentId)).toBe(true);
  });

  it("onIssueStateChange edits the thread parent message", async () => {
    const s = await seed(db);
    const adapter = createFakeAdapter();
    const registry = createMessagingRegistry();
    registry.register(adapter);
    const router = createMessagingRouter({ db, registry, backend: "fake" });

    const thread = await router.getOrCreateThread({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
    });
    const [threadRow] = await db
      .select()
      .from(messagingThreads)
      .where(eq(messagingThreads.id, thread.id));

    await db
      .update(issues)
      .set({ status: "in_progress", title: "Fix login 2" })
      .where(eq(issues.id, s.issueId));

    await router.onIssueStateChange(s.issueId);

    const [ch] = await db
      .select()
      .from(messagingChannels)
      .where(eq(messagingChannels.id, thread.channelId));
    const parent = await adapter.getMessage(
      ch!.externalChannelRef,
      threadRow!.parentMessageRef,
    );
    expect(parent?.body).toContain("Fix login 2");
    expect(parent?.body).toContain("in_progress");
  });

  it("ensureChannelMember adds identity to channel members", async () => {
    const s = await seed(db);
    await db.insert(messagingIdentities).values({
      companyId: s.companyId,
      agentId: s.agentId,
      backend: "fake",
      externalUserRef: "U_alice",
      state: "active",
    });

    const adapter = createFakeAdapter();
    const registry = createMessagingRegistry();
    registry.register(adapter);
    const router = createMessagingRouter({ db, registry, backend: "fake" });

    await router.ensureChannelMember({
      companyId: s.companyId,
      projectId: s.projectId,
      agentId: s.agentId,
    });
    // FakeAdapter doesn't expose member list publicly, so this is a smoke test:
    // the call should not throw and the channel row should exist.
    const rows = await db
      .select()
      .from(messagingChannels)
      .where(eq(messagingChannels.projectId, s.projectId));
    expect(rows).toHaveLength(1);
  });
});
