import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  agents,
  companies,
  createDb,
  issueCommentRefs,
  issues,
  messagingEventsInbox,
  messagingIdentities,
  projects,
} from "@paperclipai/db";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createIssueTrackerRouter } from "../messaging/router.js";
import { createEventsProcessor } from "../messaging/events.js";
import { SelfOriginationTracker } from "../messaging/adapters/linear/self-origination.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

interface Seed {
  companyId: string;
  issueId: string;
  linearIssueId: string;
  agentId: string;
}

async function seedCompany(
  db: ReturnType<typeof createDb>,
  prefix: string,
): Promise<Seed> {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({ name: `${prefix} ${suffix}`, issuePrefix: `${prefix}${suffix}` })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ companyId: company!.id, name: `P-${suffix}` })
    .returning();
  const linearIssueId = randomUUID();
  const [issue] = await db
    .insert(issues)
    .values({
      companyId: company!.id,
      projectId: project!.id,
      title: "H",
      identifier: `${prefix}${suffix}-1`,
      linearIssueId,
      linearIssueIdentifier: `${prefix}${suffix}-1`,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ companyId: company!.id, name: `agent-${suffix}` })
    .returning();
  return {
    companyId: company!.id,
    issueId: issue!.id,
    linearIssueId,
    agentId: agent!.id,
  };
}

describeIf("linear hardening", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-hardening-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(messagingEventsInbox);
    await db.delete(issueCommentRefs);
    await db.delete(messagingIdentities);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("router posts to the correct Linear issue for each company (no cross-company leak)", async () => {
    const seedA = await seedCompany(db, "A");
    const seedB = await seedCompany(db, "B");

    const adapterA = createFakeAdapter();
    const adapterB = createFakeAdapter();

    // Make the seeds live in each company's fake adapter.
    adapterA.seedComment({
      ref: "seeded-a",
      externalIssueRef: seedA.linearIssueId,
      author: "bootstrap",
      body: "in A",
    });
    adapterB.seedComment({
      ref: "seeded-b",
      externalIssueRef: seedB.linearIssueId,
      author: "bootstrap",
      body: "in B",
    });

    const routerA = createIssueTrackerRouter({
      db,
      adapter: adapterA,
      backend: "fake",
    });
    const routerB = createIssueTrackerRouter({
      db,
      adapter: adapterB,
      backend: "fake",
    });

    // Post through each company's router; each must hit only its own adapter.
    const postedA = await routerA.postComment({
      companyId: seedA.companyId,
      issueId: seedA.issueId,
      body: "hello A",
    });
    const postedB = await routerB.postComment({
      companyId: seedB.companyId,
      issueId: seedB.issueId,
      body: "hello B",
    });

    // Confirm each adapter only holds its own company's comments.
    const commentsA = [...adapterA.state.commentsByRef.values()].map(
      (c) => c.body,
    );
    const commentsB = [...adapterB.state.commentsByRef.values()].map(
      (c) => c.body,
    );
    expect(commentsA).toContain("hello A");
    expect(commentsA).not.toContain("hello B");
    expect(commentsB).toContain("hello B");
    expect(commentsB).not.toContain("hello A");

    // Confirm the comment_refs rows are scoped to their issues.
    const [refA] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.id, postedA.id));
    const [refB] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.id, postedB.id));
    expect(refA.issueId).toBe(seedA.issueId);
    expect(refB.issueId).toBe(seedB.issueId);
    expect(refA.issueId).not.toBe(refB.issueId);
  });

  it("falls back to bot_system authoring when an agent has no messaging identity", async () => {
    const s = await seedCompany(db, "C");
    const adapter = createFakeAdapter();
    adapter.seedComment({
      ref: "seed",
      externalIssueRef: s.linearIssueId,
      author: "bootstrap",
      body: "x",
    });
    const router = createIssueTrackerRouter({ db, adapter, backend: "fake" });

    // No identity row seeded for s.agentId — router must fall through to
    // bot_system and still succeed.
    await expect(
      router.postComment({
        companyId: s.companyId,
        issueId: s.issueId,
        authorAgentId: s.agentId,
        body: "bot-system",
      }),
    ).resolves.toBeDefined();

    // The posted comment's recorded authorExternalRef should be "SYSTEM".
    const posted = [...adapter.state.commentsByRef.values()].find(
      (c) => c.body === "bot-system",
    );
    expect(posted?.authorExternalRef).toBe("SYSTEM");
  });

  it("enforces comment ref uniqueness on (issueId, externalMessageRef)", async () => {
    const s = await seedCompany(db, "D");
    await db.insert(issueCommentRefs).values({
      issueId: s.issueId,
      backend: "linear",
      externalMessageRef: "C_unique",
    });
    await expect(
      db.insert(issueCommentRefs).values({
        issueId: s.issueId,
        backend: "linear",
        externalMessageRef: "C_unique",
      }),
    ).rejects.toThrow(/issue_comment_refs_issue_ref_idx|duplicate key/i);
  });

  it("events processor skips self-originated events via isSelfOriginated predicate", async () => {
    const s = await seedCompany(db, "E");
    const tracker = new SelfOriginationTracker({ ttlMs: 60_000 });

    const onCreated = vi.fn().mockResolvedValue(undefined);
    const events = createEventsProcessor({
      db,
      backend: "linear",
      onMessageCreated: onCreated,
      isSelfOriginated: (event) => {
        const ref =
          "externalCommentRef" in event && event.externalCommentRef
            ? event.externalCommentRef
            : null;
        return ref ? tracker.wasRecentlyMarked(ref) : false;
      },
    });

    // Mark the outbound comment as self-originated.
    tracker.mark("c_echo");

    await events.handle({
      kind: "comment_created",
      externalEventId: "EV_echo",
      externalIssueRef: s.linearIssueId,
      externalCommentRef: "c_echo",
      authorExternalRef: "u_app",
      bodyRaw: "my own echo",
      mentionedExternalRefs: [],
      createdAt: new Date(),
    });

    // onMessageCreated must NOT fire, and no issueCommentRefs row should have
    // been inserted.
    expect(onCreated).not.toHaveBeenCalled();
    const refs = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.externalMessageRef, "c_echo"));
    expect(refs).toHaveLength(0);

    // Inbox row is marked processed so a retry of the same event still skips.
    const [inbox] = await db
      .select()
      .from(messagingEventsInbox)
      .where(
        and(
          eq(messagingEventsInbox.backend, "linear"),
          eq(messagingEventsInbox.externalEventId, "EV_echo"),
        ),
      );
    expect(inbox?.processedAt).toBeInstanceOf(Date);
  });

  it("events processor routes non-self-originated events to onMessageCreated", async () => {
    const s = await seedCompany(db, "F");
    const onCreated = vi.fn().mockResolvedValue(undefined);
    const events = createEventsProcessor({
      db,
      backend: "linear",
      onMessageCreated: onCreated,
    });

    await events.handle({
      kind: "comment_created",
      externalEventId: "EV_inbound",
      externalIssueRef: s.linearIssueId,
      externalCommentRef: "c_inbound",
      authorExternalRef: "u_other",
      bodyRaw: "hello from Linear",
      mentionedExternalRefs: [],
      createdAt: new Date(),
    });

    expect(onCreated).toHaveBeenCalledOnce();
    const [row] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.externalMessageRef, "c_inbound"));
    expect(row).toBeDefined();
    expect(row.issueId).toBe(s.issueId);
  });
});
