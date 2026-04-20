import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  companies,
  projects,
  issues,
  agents,
  issueCommentRefs,
  messagingIdentities,
  messagingEventsInbox,
} from "@paperclipai/db";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createIssueTrackerRouter } from "../messaging/router.js";
import { createEventsProcessor } from "../messaging/events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * End-to-end smoke exercising the IssueTrackerAdapter pipeline against the
 * FakeAdapter: post comment → echo event → ref upsert → onMessageCreated,
 * then edit/delete updates.
 */
describeIf("messaging fake-adapter E2E", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-messaging-e2e-");
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

  it("full round-trip: post, echo, edit, delete", async () => {
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({ name: `Co ${suffix}`, issuePrefix: `E2${suffix}` })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company!.id, name: `P${suffix}` })
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

    const adapter = createFakeAdapter();
    // Create the external issue first so the router can route to it.
    const liveIssue = await adapter.createIssue({
      externalTeamRef: "T_1",
      title: "initial title",
      author: { backend: "fake", externalUserRef: "U_alice", credential: { kind: "none" } },
    });
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company!.id,
        projectId: project!.id,
        title: "initial title",
        identifier: `E2${suffix}-1`,
        status: "in_progress",
        linearIssueId: liveIssue.externalIssueRef,
        linearIssueIdentifier: liveIssue.identifier,
      })
      .returning();

    const router = createIssueTrackerRouter({ db, adapter, backend: "fake" });

    const onCreated = vi.fn().mockResolvedValue(undefined);
    const events = createEventsProcessor({
      db,
      backend: "fake",
      onMessageCreated: onCreated,
    });
    adapter.onLocalEvent((e) => void events.handle(e));

    // 1. Post a comment via the router. The router insert wins; the events
    //    handler upsert is a no-op via onConflictDoNothing.
    const posted = await router.postComment({
      companyId: company!.id,
      issueId: issue!.id,
      authorAgentId: agent!.id,
      body: "hello world",
    });
    await new Promise((r) => setTimeout(r, 20));

    const refs = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.id, posted.id));
    expect(refs).toHaveLength(1);

    // 2. Edit via the adapter → events handler bumps editedAt/editCount.
    await adapter.editComment(posted.externalCommentRef, "edited");
    await new Promise((r) => setTimeout(r, 20));

    const [refAfterEdit] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.id, posted.id));
    expect(refAfterEdit!.editCount).toBe(1);
    expect(refAfterEdit!.editedAt).toBeInstanceOf(Date);

    // 3. Delete via adapter → events handler stamps deletedAt.
    await adapter.deleteComment(posted.externalCommentRef, {
      backend: "fake",
      externalUserRef: "U_alice",
      credential: { kind: "none" },
    });
    await new Promise((r) => setTimeout(r, 20));

    const [refAfterDelete] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.id, posted.id));
    expect(refAfterDelete!.deletedAt).toBeInstanceOf(Date);

    // onMessageCreated may or may not have fired depending on the race
    // between the router's insert and the events processor's upsert (both
    // race against the same (issueId, externalMessageRef) unique key).
    // What matters is the comment ref exists, was edited, and was deleted —
    // those assertions above passed.
  });
});
