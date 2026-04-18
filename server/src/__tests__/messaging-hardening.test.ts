import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  companySecrets,
  projects,
  issues,
  agents,
  authUsers,
  messagingChannels,
  messagingCompanyConfig,
  messagingEventsInbox,
  messagingIdentities,
  messagingMessageRefs,
  messagingThreads,
  messagingWorkspaceInstall,
} from "@paperclipai/db";
import {
  initMessaging,
  requireMessagingContext,
  resetMessagingForTests,
  resolveMessagingContext,
} from "../messaging/index.js";
import { createEventsProcessor } from "../messaging/events.js";
import type { MessagingEvent } from "../messaging/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

async function seedSlackCompany(
  db: ReturnType<typeof createDb>,
  label: string,
): Promise<{
  companyId: string;
  agentId: string;
  projectId: string;
  issueId: string;
  workspaceInstallId: string;
  botSecretId: string;
}> {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({ name: `${label} ${suffix}`, issuePrefix: `${label}${suffix}` })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ companyId: company!.id, name: `${label}-proj-${suffix}` })
    .returning();
  const [issue] = await db
    .insert(issues)
    .values({
      companyId: company!.id,
      projectId: project!.id,
      title: `${label}-issue`,
      identifier: `${label}${suffix}-1`,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ companyId: company!.id, name: `agent-${suffix}` })
    .returning();
  const [botSecret] = await db
    .insert(companySecrets)
    .values({
      companyId: company!.id,
      name: "messaging.slack.bot_token",
      provider: "local_encrypted",
      latestVersion: 1,
    })
    .returning();
  const [signingSecret] = await db
    .insert(companySecrets)
    .values({
      companyId: company!.id,
      name: "messaging.slack.signing_secret",
      provider: "local_encrypted",
      latestVersion: 1,
    })
    .returning();
  const [install] = await db
    .insert(messagingWorkspaceInstall)
    .values({
      companyId: company!.id,
      backend: "slack",
      externalWorkspaceRef: `T_${suffix}`,
      botUserRef: `U_BOT_${suffix}`,
      botTokenSecretId: botSecret!.id,
      signingSecretId: signingSecret!.id,
      state: "active",
    })
    .returning();
  await db
    .insert(messagingCompanyConfig)
    .values({ companyId: company!.id, activeBackend: "slack" });
  return {
    companyId: company!.id,
    agentId: agent!.id,
    projectId: project!.id,
    issueId: issue!.id,
    workspaceInstallId: install!.id,
    botSecretId: botSecret!.id,
  };
}

async function seedChannelAndThreadForSlack(
  db: ReturnType<typeof createDb>,
  args: {
    companyId: string;
    projectId: string;
    issueId: string;
    workspaceInstallId: string;
    externalChannelRef: string;
    externalThreadRef: string;
  },
): Promise<{ channelId: string; threadId: string }> {
  const [channel] = await db
    .insert(messagingChannels)
    .values({
      companyId: args.companyId,
      backend: "slack",
      workspaceInstallId: args.workspaceInstallId,
      purpose: "project",
      projectId: args.projectId,
      externalChannelRef: args.externalChannelRef,
      externalChannelName: `proj-${args.externalChannelRef.slice(-6)}`,
    })
    .returning();
  const [thread] = await db
    .insert(messagingThreads)
    .values({
      issueId: args.issueId,
      channelId: channel!.id,
      backend: "slack",
      externalThreadRef: args.externalThreadRef,
      parentMessageRef: args.externalThreadRef,
    })
    .returning();
  return { channelId: channel!.id, threadId: thread!.id };
}

describeIf("messaging hardening: multi-company + cross-channel + cancel", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-messaging-hardening-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(messagingEventsInbox);
    await db.delete(messagingMessageRefs);
    await db.delete(messagingThreads);
    await db.delete(messagingIdentities);
    await db.delete(messagingChannels);
    await db.delete(messagingCompanyConfig);
    await db.delete(messagingWorkspaceInstall);
    await db.delete(companySecrets);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
    await db.delete(authUsers);
    resetMessagingForTests();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolveMessagingContext returns disabled for companies without messaging_company_config", async () => {
    initMessaging({
      db,
      slack: {
        getBotToken: async () => "xoxb-token",
        getUserToken: async () => "xoxp-token",
      },
    });
    const suffix = randomUUID().slice(0, 6);
    const [company] = await db
      .insert(companies)
      .values({ name: `NoConfig${suffix}`, issuePrefix: `N${suffix}` })
      .returning();

    const ctx = await resolveMessagingContext(company!.id);
    expect(ctx.status).toBe("disabled");
  });

  it("resolveMessagingContext returns not_installed when active_backend='slack' but no workspace install", async () => {
    initMessaging({
      db,
      slack: {
        getBotToken: async () => "xoxb-token",
        getUserToken: async () => "xoxp-token",
      },
    });
    const suffix = randomUUID().slice(0, 6);
    const [company] = await db
      .insert(companies)
      .values({ name: `NoInstall${suffix}`, issuePrefix: `N${suffix}` })
      .returning();
    await db
      .insert(messagingCompanyConfig)
      .values({ companyId: company!.id, activeBackend: "slack" });

    const ctx = await resolveMessagingContext(company!.id);
    expect(ctx.status).toBe("not_installed");
  });

  it("two companies with Slack installed resolve independent contexts and do not share identities across workspaces", async () => {
    initMessaging({
      db,
      slack: {
        getBotToken: async () => "xoxb-token",
        getUserToken: async () => "xoxp-token",
      },
    });
    const a = await seedSlackCompany(db, "A");
    const b = await seedSlackCompany(db, "B");

    // Seed an identity in workspace A with external user ref U_dup.
    await db.insert(messagingIdentities).values({
      companyId: a.companyId,
      agentId: a.agentId,
      backend: "slack",
      workspaceInstallId: a.workspaceInstallId,
      externalUserRef: "U_DUP",
      state: "active",
    });
    // Seed an identity in workspace B with the SAME external user ref.
    // Prior to hardening this would have failed the backend-global
    // unique index; now it's scoped by workspace_install_id.
    await db.insert(messagingIdentities).values({
      companyId: b.companyId,
      agentId: b.agentId,
      backend: "slack",
      workspaceInstallId: b.workspaceInstallId,
      externalUserRef: "U_DUP",
      state: "active",
    });

    const ctxA = await requireMessagingContext(a.companyId);
    const ctxB = await requireMessagingContext(b.companyId);
    expect(ctxA.workspaceInstall?.id).toBe(a.workspaceInstallId);
    expect(ctxB.workspaceInstall?.id).toBe(b.workspaceInstallId);
    expect(ctxA.workspaceInstall?.id).not.toBe(ctxB.workspaceInstall?.id);

    const identitiesA = await db
      .select()
      .from(messagingIdentities)
      .where(
        and(
          eq(messagingIdentities.workspaceInstallId, a.workspaceInstallId),
          eq(messagingIdentities.externalUserRef, "U_DUP"),
        ),
      );
    expect(identitiesA).toHaveLength(1);
    expect(identitiesA[0]!.companyId).toBe(a.companyId);

    const identitiesB = await db
      .select()
      .from(messagingIdentities)
      .where(
        and(
          eq(messagingIdentities.workspaceInstallId, b.workspaceInstallId),
          eq(messagingIdentities.externalUserRef, "U_DUP"),
        ),
      );
    expect(identitiesB).toHaveLength(1);
    expect(identitiesB[0]!.companyId).toBe(b.companyId);
  });

  it("cross-channel message-ref collisions: same external_message_ref in two channels resolves to the correct row", async () => {
    initMessaging({
      db,
      slack: {
        getBotToken: async () => "xoxb-token",
        getUserToken: async () => "xoxp-token",
      },
    });
    const a = await seedSlackCompany(db, "X");
    const b = await seedSlackCompany(db, "Y");

    const aChan = await seedChannelAndThreadForSlack(db, {
      companyId: a.companyId,
      projectId: a.projectId,
      issueId: a.issueId,
      workspaceInstallId: a.workspaceInstallId,
      externalChannelRef: "C_A",
      externalThreadRef: "1700000000.000001",
    });
    const bChan = await seedChannelAndThreadForSlack(db, {
      companyId: b.companyId,
      projectId: b.projectId,
      issueId: b.issueId,
      workspaceInstallId: b.workspaceInstallId,
      externalChannelRef: "C_B",
      externalThreadRef: "1700000000.000002",
    });

    // Insert a message ref with the same external_message_ref in both
    // threads. Prior to hardening this would collide on
    // (backend, external_message_ref); now the unique is
    // (thread_id, external_message_ref).
    const sharedRef = "1711111111.222222";
    const [aRef] = await db
      .insert(messagingMessageRefs)
      .values({
        threadId: aChan.threadId,
        backend: "slack",
        externalMessageRef: sharedRef,
      })
      .returning();
    const [bRef] = await db
      .insert(messagingMessageRefs)
      .values({
        threadId: bChan.threadId,
        backend: "slack",
        externalMessageRef: sharedRef,
      })
      .returning();
    expect(aRef!.id).not.toBe(bRef!.id);

    // Dispatch an edit event on channel A for the shared ts. Only the
    // A-thread row should get edited.
    const eventsA = createEventsProcessor({
      db,
      backend: "slack",
      workspaceInstallId: a.workspaceInstallId,
    });
    const editEvent: MessagingEvent = {
      kind: "message_changed",
      externalEventId: "EV_edit_A",
      channelRef: "C_A",
      messageRef: sharedRef,
      bodyRaw: "edited on A",
      editedAt: new Date(),
    };
    await eventsA.handle(editEvent);

    const [aAfter] = await db
      .select()
      .from(messagingMessageRefs)
      .where(eq(messagingMessageRefs.id, aRef!.id));
    const [bAfter] = await db
      .select()
      .from(messagingMessageRefs)
      .where(eq(messagingMessageRefs.id, bRef!.id));
    expect(aAfter!.editCount).toBe(1);
    expect(aAfter!.editedAt).toBeInstanceOf(Date);
    expect(bAfter!.editCount).toBe(0);
    expect(bAfter!.editedAt).toBeNull();
  });

  it("queued-comment cancel flips suppressedForWake and leaves deletedAt untouched", async () => {
    // Use a fake-backend company so removeComment doesn't try to fetch
    // live body text through a real Slack adapter. The cancel path is
    // backend-agnostic — the assertions exercise (suppressedForWake,
    // deletedAt, metadata.cancelledAt) which are DB-only.
    initMessaging({ db, testFallbackBackend: "fake" });
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({ name: `Cancel${suffix}`, issuePrefix: `C${suffix}` })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company!.id, name: `cancel-proj` })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company!.id,
        projectId: project!.id,
        title: "cancel-issue",
        identifier: `C${suffix}-1`,
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: "cancel-agent" })
      .returning();
    const [channel] = await db
      .insert(messagingChannels)
      .values({
        companyId: company!.id,
        backend: "fake",
        purpose: "project",
        projectId: project!.id,
        externalChannelRef: `C_fake_${suffix}`,
        externalChannelName: "cancel-chan",
      })
      .returning();
    const [thread] = await db
      .insert(messagingThreads)
      .values({
        issueId: issue!.id,
        channelId: channel!.id,
        backend: "fake",
        externalThreadRef: `T_fake_${suffix}`,
        parentMessageRef: `T_fake_${suffix}`,
      })
      .returning();
    const [ref] = await db
      .insert(messagingMessageRefs)
      .values({
        threadId: thread!.id,
        backend: "fake",
        externalMessageRef: `M_fake_${suffix}`,
        authorAgentId: agent!.id,
      })
      .returning();

    const { issueService } = await import("../services/issues.js");
    const svc = issueService(db);
    const removed = await svc.removeComment(ref!.id);
    expect(removed).not.toBeNull();

    const [afterRow] = await db
      .select()
      .from(messagingMessageRefs)
      .where(eq(messagingMessageRefs.id, ref!.id));
    expect(afterRow!.suppressedForWake).toBe(true);
    expect(afterRow!.deletedAt).toBeNull();
    const metadata = (afterRow!.metadata ?? {}) as Record<string, unknown>;
    expect(typeof metadata.cancelledAt).toBe("string");
  });

  it("events.handle with workspaceInstallId ignores channels from other workspaces", async () => {
    initMessaging({
      db,
      slack: {
        getBotToken: async () => "xoxb-token",
        getUserToken: async () => "xoxp-token",
      },
    });
    const a = await seedSlackCompany(db, "P");
    const b = await seedSlackCompany(db, "Q");
    // Both companies happen to have a channel with the same external_channel_ref.
    await seedChannelAndThreadForSlack(db, {
      companyId: a.companyId,
      projectId: a.projectId,
      issueId: a.issueId,
      workspaceInstallId: a.workspaceInstallId,
      externalChannelRef: "C_SHARED",
      externalThreadRef: "1700000000.888888",
    });
    const bChan = await seedChannelAndThreadForSlack(db, {
      companyId: b.companyId,
      projectId: b.projectId,
      issueId: b.issueId,
      workspaceInstallId: b.workspaceInstallId,
      externalChannelRef: "C_SHARED",
      externalThreadRef: "1700000000.888888",
    });
    // Inbound message event on workspace B; the A-scoped events processor
    // must not see it.
    const eventsB = createEventsProcessor({
      db,
      backend: "slack",
      workspaceInstallId: b.workspaceInstallId,
    });
    const event: MessagingEvent = {
      kind: "message",
      externalEventId: "EV_message_B",
      channelRef: "C_SHARED",
      threadRef: "1700000000.888888",
      messageRef: "1700000000.999999",
      authorExternalRef: "U_B",
      bodyRaw: "hello B",
      createdAt: new Date(),
    };
    await eventsB.handle(event);

    const allRefs = await db.select().from(messagingMessageRefs);
    expect(allRefs).toHaveLength(1);
    expect(allRefs[0]!.threadId).toBe(bChan.threadId);
  });
});
