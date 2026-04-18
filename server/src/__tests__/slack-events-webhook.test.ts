import { randomUUID, createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  issues,
  messagingChannels,
  messagingEventsInbox,
  messagingIdentities,
  messagingMessageRefs,
  messagingThreads,
  messagingCompanyConfig,
  messagingWorkspaceInstall,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { messagingSlackRoutes } from "../routes/messaging-slack.js";
import { errorHandler } from "../middleware/index.js";
import {
  initMessaging,
  messagingRegistry,
  resetMessagingForTests,
} from "../messaging/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

const SIGNING_SECRET = "slack-signing-secret";

function signRequest(rawBody: string, timestamp: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return "v0=" + createHmac("sha256", SIGNING_SECRET).update(base).digest("hex");
}

function buildApp(db: ReturnType<typeof createDb>) {
  const app = express();
  // Mirrors the verify-hook in app.ts so /events can read rawBody.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "none",
      source: "none",
    };
    next();
  });
  app.use(
    "/api/messaging/slack",
    messagingSlackRoutes(db, {
      readEnv: () => ({
        clientId: "id",
        clientSecret: "secret",
        signingSecret: SIGNING_SECRET,
        redirectBaseUrl: "https://paperclip.test",
      }),
    }),
  );
  app.use(errorHandler);
  return app;
}

async function seedWorkspaceAndThread(
  db: ReturnType<typeof createDb>,
): Promise<{
  companyId: string;
  teamId: string;
  channelExternalRef: string;
  threadExternalRef: string;
  agentExternalUserRef: string;
  issueId: string;
}> {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "EvtCo",
    issuePrefix: `EV${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
  });
  const [project] = await db
    .insert(projects)
    .values({ companyId, name: "Plow" })
    .returning();
  const [issue] = await db
    .insert(issues)
    .values({
      companyId,
      projectId: project!.id,
      title: "slack-events",
      identifier: "EV-1",
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ companyId, name: "events-alice" })
    .returning();

  const [botSecret] = await db
    .insert(companySecrets)
    .values({
      companyId,
      name: "messaging.slack.bot_token",
      provider: "local_encrypted",
      latestVersion: 1,
    })
    .returning();
  const [signingSecret] = await db
    .insert(companySecrets)
    .values({
      companyId,
      name: "messaging.slack.signing_secret",
      provider: "local_encrypted",
      latestVersion: 1,
    })
    .returning();

  const teamId = "T_EVENTS";
  await db.insert(messagingWorkspaceInstall).values({
    companyId,
    backend: "slack",
    externalWorkspaceRef: teamId,
    botUserRef: "U_BOT",
    botTokenSecretId: botSecret!.id,
    signingSecretId: signingSecret!.id,
    state: "active",
  });
  await db.insert(messagingCompanyConfig).values({
    companyId,
    activeBackend: "slack",
  });

  const channelExternalRef = "C_SLACK_TEST";
  const [channel] = await db
    .insert(messagingChannels)
    .values({
      companyId,
      backend: "slack",
      purpose: "project",
      projectId: project!.id,
      externalChannelRef: channelExternalRef,
      externalChannelName: "proj-test",
    })
    .returning();
  const threadExternalRef = "1711111111.000000";
  await db.insert(messagingThreads).values({
    issueId: issue!.id,
    channelId: channel!.id,
    backend: "slack",
    externalThreadRef: threadExternalRef,
    parentMessageRef: threadExternalRef,
  });

  const agentExternalUserRef = "U_AGENT_ALICE";
  await db.insert(messagingIdentities).values({
    companyId,
    agentId: agent!.id,
    backend: "slack",
    externalUserRef: agentExternalUserRef,
    state: "active",
  });

  return {
    companyId,
    teamId,
    channelExternalRef,
    threadExternalRef,
    agentExternalUserRef,
    issueId: issue!.id,
  };
}

describeIf("messaging slack events webhook", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-events-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    // Re-initialize messaging with a SlackAdapter backed by stub resolvers.
    try {
      messagingRegistry.unregister("fake");
    } catch {
      // no-op
    }
    resetMessagingForTests();
    initMessaging({
      db,
      slack: {
        getBotToken: async () => "xoxb-FAKE",
        getUserToken: async () => "xoxp-FAKE",
      },
    });
  });

  afterEach(async () => {
    await db.delete(messagingEventsInbox);
    await db.delete(messagingMessageRefs);
    await db.delete(messagingThreads);
    await db.delete(messagingChannels);
    await db.delete(messagingIdentities);
    await db.delete(messagingCompanyConfig);
    await db.delete(messagingWorkspaceInstall);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    try {
      messagingRegistry.unregister("slack");
    } catch {
      // no-op
    }
    try {
      messagingRegistry.unregister("fake");
    } catch {
      // no-op
    }
    resetMessagingForTests();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("short-circuits url_verification without a signature", async () => {
    const app = buildApp(db);
    const res = await request(app)
      .post("/api/messaging/slack/events")
      .send({ type: "url_verification", challenge: "CHAL-42" });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe("CHAL-42");
  });

  it("accepts a signed message event and persists a ref", async () => {
    const seed = await seedWorkspaceAndThread(db);
    // Override the per-workspace signing secret to the known test value.
    // Since we never wrote the real encrypted material, just rewrite the
    // install to point at a freshly-stored secret via the write path.
    const app = buildApp(db);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = {
      type: "event_callback",
      event_id: "Ev_evt_1",
      team_id: seed.teamId,
      event: {
        type: "message",
        ts: "1711111112.000000",
        thread_ts: seed.threadExternalRef,
        channel: seed.channelExternalRef,
        user: seed.agentExternalUserRef,
        text: "hello from slack",
      },
    };
    const rawBody = JSON.stringify(payload);
    // The route falls back to env signing secret when the per-install secret
    // can't be resolved (we inserted a placeholder secret version-less row).
    // That fallback lets the test's SIGNING_SECRET verify correctly.
    const signature = signRequest(rawBody, timestamp);

    const res = await request(app)
      .post("/api/messaging/slack/events")
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", timestamp)
      .set("x-slack-signature", signature)
      .send(rawBody);
    expect(res.status).toBe(200);

    // Allow async handler to drain.
    await new Promise((r) => setTimeout(r, 30));

    const refs = await db
      .select()
      .from(messagingMessageRefs)
      .where(
        and(
          eq(messagingMessageRefs.backend, "slack"),
          eq(messagingMessageRefs.externalMessageRef, "1711111112.000000"),
        ),
      );
    expect(refs).toHaveLength(1);
  });

  it("rejects a tampered signature with 401", async () => {
    const seed = await seedWorkspaceAndThread(db);
    const app = buildApp(db);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = {
      type: "event_callback",
      event_id: "Ev_evt_bad",
      team_id: seed.teamId,
      event: {
        type: "message",
        ts: "1711111113.000000",
        thread_ts: seed.threadExternalRef,
        channel: seed.channelExternalRef,
        user: seed.agentExternalUserRef,
        text: "tampered",
      },
    };
    const rawBody = JSON.stringify(payload);
    const badSignature =
      "v0=" + "0".repeat(createHmac("sha256", SIGNING_SECRET).update("x").digest("hex").length);

    const res = await request(app)
      .post("/api/messaging/slack/events")
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", timestamp)
      .set("x-slack-signature", badSignature)
      .send(rawBody);
    expect(res.status).toBe(401);

    const refs = await db
      .select()
      .from(messagingMessageRefs)
      .where(eq(messagingMessageRefs.externalMessageRef, "1711111113.000000"));
    expect(refs).toHaveLength(0);
  });
});
