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
import { createEventsProcessor } from "../messaging/events.js";
import type { MessagingEvent } from "../messaging/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

async function seedFull(db: ReturnType<typeof createDb>) {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({ name: `Co ${suffix}`, issuePrefix: `CE${suffix}` })
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
      title: "events",
      identifier: `CE${suffix}-1`,
      linearIssueId,
      linearIssueIdentifier: `CE${suffix}-1`,
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
    issueId: issue!.id,
    linearIssueId,
    agentId: agent!.id,
  };
}

describeIf("messaging events processor", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-messaging-events-");
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

  it("dedups duplicate externalEventId and fires onMessageCreated once", async () => {
    const s = await seedFull(db);
    const onCreated = vi.fn().mockResolvedValue(undefined);
    const events = createEventsProcessor({ db, backend: "fake", onMessageCreated: onCreated });

    const event: MessagingEvent = {
      kind: "comment_created",
      externalEventId: "EV1",
      externalIssueRef: s.linearIssueId,
      externalCommentRef: "C_ext_1",
      authorExternalRef: "U_alice",
      bodyRaw: "hi",
      mentionedExternalRefs: [],
      createdAt: new Date(),
    };

    await events.handle(event);
    await events.handle(event);

    const refs = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.externalMessageRef, "C_ext_1"));
    expect(refs).toHaveLength(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("handleEdit bumps editedAt and editCount", async () => {
    const s = await seedFull(db);
    const events = createEventsProcessor({ db, backend: "fake" });

    await events.handle({
      kind: "comment_created",
      externalEventId: "EV_c1",
      externalIssueRef: s.linearIssueId,
      externalCommentRef: "C_ext_2",
      authorExternalRef: "U_alice",
      bodyRaw: "v1",
      mentionedExternalRefs: [],
      createdAt: new Date(),
    });

    const editEvent: MessagingEvent = {
      kind: "comment_updated",
      externalEventId: "EV_edit",
      externalCommentRef: "C_ext_2",
      externalIssueRef: s.linearIssueId,
      bodyRaw: "v2",
      editedAt: new Date(),
    };
    await events.handle(editEvent);

    const [refAfter] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.externalMessageRef, "C_ext_2"));
    expect(refAfter!.editCount).toBe(1);
    expect(refAfter!.editedAt).toBeInstanceOf(Date);
  });

  it("handleDelete sets deletedAt", async () => {
    const s = await seedFull(db);
    const events = createEventsProcessor({ db, backend: "fake" });

    await events.handle({
      kind: "comment_created",
      externalEventId: "EV_c1",
      externalIssueRef: s.linearIssueId,
      externalCommentRef: "C_ext_3",
      authorExternalRef: "U_alice",
      bodyRaw: "gone",
      mentionedExternalRefs: [],
      createdAt: new Date(),
    });

    await events.handle({
      kind: "comment_deleted",
      externalEventId: "EV_del",
      externalCommentRef: "C_ext_3",
      externalIssueRef: s.linearIssueId,
      deletedAt: new Date(),
    });

    const [refAfter] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.externalMessageRef, "C_ext_3"));
    expect(refAfter!.deletedAt).toBeInstanceOf(Date);
  });

  it("reactions are tracked per emoji per reactor", async () => {
    const s = await seedFull(db);
    const events = createEventsProcessor({ db, backend: "fake" });

    await events.handle({
      kind: "comment_created",
      externalEventId: "EV_c1",
      externalIssueRef: s.linearIssueId,
      externalCommentRef: "C_ext_4",
      authorExternalRef: "U_alice",
      bodyRaw: "react",
      mentionedExternalRefs: [],
      createdAt: new Date(),
    });

    const base = {
      externalIssueRef: s.linearIssueId,
      externalCommentRef: "C_ext_4",
      emoji: "+1",
      at: new Date(),
    } as const;
    await events.handle({ ...base, kind: "reaction_added", externalEventId: "R1", reactorExternalRef: "U_a" });
    await events.handle({ ...base, kind: "reaction_added", externalEventId: "R2", reactorExternalRef: "U_b" });
    await events.handle({ ...base, kind: "reaction_removed", externalEventId: "R3", reactorExternalRef: "U_a" });

    const [refAfter] = await db
      .select()
      .from(issueCommentRefs)
      .where(eq(issueCommentRefs.externalMessageRef, "C_ext_4"));
    expect(refAfter!.reactions).toEqual({ "+1": ["U_b"] });
  });

  it("respects suppressedForWake by not calling onMessageCreated", async () => {
    const s = await seedFull(db);

    // Pre-seed a ref with suppressedForWake=true and the same externalMessageRef
    // the inbound event carries.
    await db.insert(issueCommentRefs).values({
      issueId: s.issueId,
      backend: "fake",
      externalMessageRef: "C_pre",
      authorAgentId: s.agentId,
      suppressedForWake: true,
    });

    const onCreated = vi.fn().mockResolvedValue(undefined);
    const events = createEventsProcessor({ db, backend: "fake", onMessageCreated: onCreated });

    await events.handle({
      kind: "comment_created",
      externalEventId: "EV_sup",
      externalIssueRef: s.linearIssueId,
      externalCommentRef: "C_pre",
      authorExternalRef: "U_alice",
      bodyRaw: "suppressed",
      mentionedExternalRefs: [],
      createdAt: new Date(),
    });

    expect(onCreated).not.toHaveBeenCalled();
  });
});
