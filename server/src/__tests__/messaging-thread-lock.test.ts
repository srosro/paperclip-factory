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
import { createMessagingRouter } from "../messaging/router.js";
import { MessagingThreadLocked } from "../messaging/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

describeIf("messaging thread lock", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-thread-lock-");
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

  async function seed() {
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({ name: `Co ${suffix}`, issuePrefix: `CL${suffix}` })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company!.id, name: `P${suffix}` })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company!.id,
        projectId: project!.id,
        title: "lock test",
        identifier: `CL${suffix}-1`,
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: `alice-${suffix}` })
      .returning();
    await db.insert(messagingIdentities).values({
      companyId: company!.id,
      agentId: agent!.id,
      backend: "fake",
      externalUserRef: "U_alice",
      state: "active",
    });
    return {
      companyId: company!.id,
      projectId: project!.id,
      issueId: issue!.id,
      agentId: agent!.id,
    };
  }

  it("setThreadLocked flips messaging_threads.state and blocks postMessage", async () => {
    const s = await seed();
    const adapter = createFakeAdapter();
    const router = createMessagingRouter({ db, adapter, backend: "fake" });

    await router.postMessage({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
      authorAgentId: s.agentId,
      body: "before lock",
    });

    await router.setThreadLocked(s.issueId, true);

    const [locked] = await db
      .select({ state: messagingThreads.state })
      .from(messagingThreads)
      .where(eq(messagingThreads.issueId, s.issueId));
    expect(locked!.state).toBe("locked");

    await expect(
      router.postMessage({
        companyId: s.companyId,
        issueId: s.issueId,
        projectId: s.projectId,
        authorAgentId: s.agentId,
        body: "after lock",
      }),
    ).rejects.toBeInstanceOf(MessagingThreadLocked);
  });

  it("unlock restores posting", async () => {
    const s = await seed();
    const adapter = createFakeAdapter();
    const router = createMessagingRouter({ db, adapter, backend: "fake" });

    await router.postMessage({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
      authorAgentId: s.agentId,
      body: "first",
    });
    await router.setThreadLocked(s.issueId, true);
    await router.setThreadLocked(s.issueId, false);

    const posted = await router.postMessage({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
      authorAgentId: s.agentId,
      body: "after unlock",
    });
    expect(posted.id).toBeTruthy();

    const [after] = await db
      .select({ state: messagingThreads.state })
      .from(messagingThreads)
      .where(eq(messagingThreads.issueId, s.issueId));
    expect(after!.state).toBe("open");
  });

  it("setThreadLocked is a no-op when no thread exists yet", async () => {
    const s = await seed();
    const adapter = createFakeAdapter();
    const router = createMessagingRouter({ db, adapter, backend: "fake" });

    await expect(router.setThreadLocked(s.issueId, true)).resolves.toBeUndefined();
  });
});
