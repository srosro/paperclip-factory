import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  companies,
  projects,
  issues,
  agents,
  messagingChannels,
  messagingThreads,
  messagingIdentities,
  messagingMessageRefs,
  messagingEventsInbox,
} from "@paperclipai/db";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import { createMessagingRouter } from "../messaging/router.js";
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
  const [issue] = await db
    .insert(issues)
    .values({
      companyId: company!.id,
      projectId: project!.id,
      title: "events",
      identifier: `CE${suffix}-1`,
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

describeIf("messaging events processor", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-messaging-events-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(messagingEventsInbox);
    await db.delete(messagingMessageRefs);
    await db.delete(messagingThreads);
    await db.delete(messagingIdentities);
    await db.delete(messagingChannels);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("dedups duplicate externalEventId", async () => {
    const s = await seedFull(db);
    const adapter = createFakeAdapter();
    const router = createMessagingRouter({ db, adapter, backend: "fake" });
    const onCreated = vi.fn().mockResolvedValue(undefined);
    const events = createEventsProcessor({ db, backend: "fake", onMessageCreated: onCreated });

    // Establish a thread so events have a target
    const thread = await router.getOrCreateThread({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
    });
    const [channel] = await db
      .select()
      .from(messagingChannels)
      .where(eq(messagingChannels.id, thread.channelId));

    const event: MessagingEvent = {
      kind: "message",
      externalEventId: "EV1",
      channelRef: channel!.externalChannelRef,
      threadRef: thread.threadRef,
      messageRef: "M_ext_1",
      authorExternalRef: "U_alice",
      bodyRaw: "hi",
      createdAt: new Date(),
    };

    await events.handle(event);
    await events.handle(event);

    const refs = await db
      .select()
      .from(messagingMessageRefs)
      .where(eq(messagingMessageRefs.externalMessageRef, "M_ext_1"));
    expect(refs).toHaveLength(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("handleEdit bumps editedAt and editCount", async () => {
    const s = await seedFull(db);
    const adapter = createFakeAdapter();
    const router = createMessagingRouter({ db, adapter, backend: "fake" });

    // Wire events to the adapter's local echo so postMessage causes a real event
    const events = createEventsProcessor({ db, backend: "fake" });
    adapter.onLocalEvent((e) => void events.handle(e));

    await router.postMessage({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
      authorAgentId: s.agentId,
      body: "v1",
    });
    // Allow microtask queue to drain the onLocalEvent handler
    await new Promise((r) => setTimeout(r, 10));

    const [refBefore] = await db.select().from(messagingMessageRefs);
    expect(refBefore!.editCount).toBe(0);

    const editEvent: MessagingEvent = {
      kind: "message_changed",
      externalEventId: "EV_edit",
      messageRef: refBefore!.externalMessageRef,
      channelRef: "C_ignored",
      bodyRaw: "v2",
      editedAt: new Date(),
    };
    await events.handle(editEvent);

    const [refAfter] = await db.select().from(messagingMessageRefs);
    expect(refAfter!.editCount).toBe(1);
    expect(refAfter!.editedAt).toBeInstanceOf(Date);
  });

  it("handleDelete sets deletedAt", async () => {
    const s = await seedFull(db);
    const adapter = createFakeAdapter();
    const router = createMessagingRouter({ db, adapter, backend: "fake" });
    const events = createEventsProcessor({ db, backend: "fake" });
    adapter.onLocalEvent((e) => void events.handle(e));

    await router.postMessage({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
      authorAgentId: s.agentId,
      body: "gone",
    });
    await new Promise((r) => setTimeout(r, 10));

    const [ref] = await db.select().from(messagingMessageRefs);

    await events.handle({
      kind: "message_deleted",
      externalEventId: "EV_del",
      messageRef: ref!.externalMessageRef,
      channelRef: "C_ignored",
      deletedAt: new Date(),
    });

    const [refAfter] = await db.select().from(messagingMessageRefs);
    expect(refAfter!.deletedAt).toBeInstanceOf(Date);
  });

  it("reactions are tracked per emoji per reactor", async () => {
    const s = await seedFull(db);
    const adapter = createFakeAdapter();
    const router = createMessagingRouter({ db, adapter, backend: "fake" });
    const events = createEventsProcessor({ db, backend: "fake" });
    adapter.onLocalEvent((e) => void events.handle(e));

    await router.postMessage({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
      authorAgentId: s.agentId,
      body: "react",
    });
    await new Promise((r) => setTimeout(r, 10));
    const [ref] = await db.select().from(messagingMessageRefs);

    const base = {
      externalEventId: "",
      messageRef: ref!.externalMessageRef,
      channelRef: "C_ignored",
      emoji: "+1",
      at: new Date(),
    };
    await events.handle({ ...base, kind: "reaction_added", externalEventId: "R1", reactorExternalRef: "U_a" });
    await events.handle({ ...base, kind: "reaction_added", externalEventId: "R2", reactorExternalRef: "U_b" });
    await events.handle({ ...base, kind: "reaction_removed", externalEventId: "R3", reactorExternalRef: "U_a" });

    const [refAfter] = await db.select().from(messagingMessageRefs);
    expect(refAfter!.reactions).toEqual({ "+1": ["U_b"] });
  });

  it("respects suppressedForWake by not calling onMessageCreated", async () => {
    const s = await seedFull(db);
    const adapter = createFakeAdapter();
    const router = createMessagingRouter({ db, adapter, backend: "fake" });
    const thread = await router.getOrCreateThread({
      companyId: s.companyId,
      issueId: s.issueId,
      projectId: s.projectId,
    });
    const [channel] = await db
      .select()
      .from(messagingChannels)
      .where(eq(messagingChannels.id, thread.channelId));

    // Pre-seed a ref with suppressedForWake=true and the same externalMessageRef
    // that the inbound event will carry.
    await db.insert(messagingMessageRefs).values({
      threadId: thread.id,
      backend: "fake",
      externalMessageRef: "M_pre",
      authorAgentId: s.agentId,
      suppressedForWake: true,
    });

    const onCreated = vi.fn().mockResolvedValue(undefined);
    const events = createEventsProcessor({ db, backend: "fake", onMessageCreated: onCreated });

    await events.handle({
      kind: "message",
      externalEventId: "EV_sup",
      channelRef: channel!.externalChannelRef,
      threadRef: thread.threadRef,
      messageRef: "M_pre",
      authorExternalRef: "U_alice",
      bodyRaw: "suppressed",
      createdAt: new Date(),
    });

    expect(onCreated).not.toHaveBeenCalled();
  });
});
