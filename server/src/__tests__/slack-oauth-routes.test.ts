import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  messagingCompanyConfig,
  messagingIdentities,
  messagingWorkspaceInstall,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { messagingSlackRoutes } from "../routes/messaging-slack.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

const FAKE_ENV = {
  clientId: "slack-client-id",
  clientSecret: "slack-client-secret",
  signingSecret: "slack-signing-secret",
  redirectBaseUrl: "https://paperclip.test",
};

function buildApp(
  db: ReturnType<typeof createDb>,
  opts: {
    actorCompanyIds?: string[];
    exchangeResult?: unknown;
  } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: opts.actorCompanyIds ?? [],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use(
    "/api/messaging/slack",
    messagingSlackRoutes(db, {
      readEnv: () => ({ ...FAKE_ENV }),
      exchangeCode: async () => opts.exchangeResult as any,
    }),
  );
  app.use(errorHandler);
  return app;
}

// Grab a signed state token by hitting /oauth/.../start with a matching actor.
async function getBotInstallState(
  db: ReturnType<typeof createDb>,
  companyId: string,
): Promise<string> {
  const app = buildApp(db, { actorCompanyIds: [companyId] });
  const res = await request(app)
    .get("/api/messaging/slack/oauth/bot/start")
    .query({ companyId });
  expect(res.status).toBe(302);
  const location = new URL(res.header.location as string);
  const state = location.searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
}

async function getUserInstallState(
  db: ReturnType<typeof createDb>,
  agentId: string,
  companyId: string,
): Promise<string> {
  const app = buildApp(db, { actorCompanyIds: [companyId] });
  const res = await request(app)
    .get("/api/messaging/slack/oauth/user/start")
    .query({ agentId });
  expect(res.status).toBe(302);
  const location = new URL(res.header.location as string);
  const state = location.searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
}

describeIf("messaging slack oauth routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-oauth-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  let companyId!: string;
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Slack Co",
      issuePrefix: `SL${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
  });

  afterEach(async () => {
    await db.delete(messagingIdentities);
    await db.delete(messagingCompanyConfig);
    await db.delete(messagingWorkspaceInstall);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("bot callback creates install + bot token secret", async () => {
    const state = await getBotInstallState(db, companyId);
    const app = buildApp(db, {
      actorCompanyIds: [companyId],
      exchangeResult: {
        ok: true,
        access_token: "xoxb-FAKE-BOT",
        bot_user_id: "U_BOT",
        team: { id: "T_WS1", name: "Workspace One" },
      },
    });

    const res = await request(app)
      .get("/api/messaging/slack/oauth/bot/callback")
      .query({ code: "AUTH_CODE", state });
    expect(res.status).toBe(302);
    expect(res.header.location).toMatch(/\/settings\/messaging/);

    const installs = await db
      .select()
      .from(messagingWorkspaceInstall)
      .where(
        and(
          eq(messagingWorkspaceInstall.companyId, companyId),
          eq(messagingWorkspaceInstall.backend, "slack"),
        ),
      );
    expect(installs).toHaveLength(1);
    expect(installs[0]!.externalWorkspaceRef).toBe("T_WS1");
    expect(installs[0]!.botUserRef).toBe("U_BOT");
    expect(installs[0]!.state).toBe("active");

    const secrets = await db
      .select()
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, companyId),
          eq(companySecrets.name, "messaging.slack.bot_token"),
        ),
      );
    expect(secrets).toHaveLength(1);
    expect(installs[0]!.botTokenSecretId).toBe(secrets[0]!.id);
  });

  it("user callback rejects conflict with another agent's binding", async () => {
    // Seed install so the environment is realistic.
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
    await db.insert(messagingWorkspaceInstall).values({
      companyId,
      backend: "slack",
      externalWorkspaceRef: "T_WS1",
      botUserRef: "U_BOT",
      botTokenSecretId: botSecret!.id,
      signingSecretId: signingSecret!.id,
      state: "active",
    });

    const [agentA] = await db
      .insert(agents)
      .values({ companyId, name: "agent-a" })
      .returning();
    const [agentB] = await db
      .insert(agents)
      .values({ companyId, name: "agent-b" })
      .returning();

    // Pre-bind SLACK_USER=U_SHARED to agentA.
    await db.insert(messagingIdentities).values({
      companyId,
      agentId: agentA!.id,
      backend: "slack",
      externalUserRef: "U_SHARED",
      state: "active",
    });

    const state = await getUserInstallState(db, agentB!.id, companyId);
    const app = buildApp(db, {
      actorCompanyIds: [companyId],
      exchangeResult: {
        ok: true,
        authed_user: { id: "U_SHARED", access_token: "xoxp-FAKE-USER" },
      },
    });

    const res = await request(app)
      .get("/api/messaging/slack/oauth/user/callback")
      .query({ code: "AUTH_CODE", state });
    expect(res.status).toBe(409);

    // Agent B's identity should not have been created.
    const agentBIdentities = await db
      .select()
      .from(messagingIdentities)
      .where(eq(messagingIdentities.agentId, agentB!.id));
    expect(agentBIdentities).toHaveLength(0);
  });

  it("user callback upserts identity for a fresh slack user id", async () => {
    // Minimal install seed (callback doesn't strictly need it for the user
    // flow, but in production it always exists).
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
    await db.insert(messagingWorkspaceInstall).values({
      companyId,
      backend: "slack",
      externalWorkspaceRef: "T_WS1",
      botUserRef: "U_BOT",
      botTokenSecretId: botSecret!.id,
      signingSecretId: signingSecret!.id,
      state: "active",
    });

    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "agent-fresh" })
      .returning();

    const state = await getUserInstallState(db, agent!.id, companyId);
    const app = buildApp(db, {
      actorCompanyIds: [companyId],
      exchangeResult: {
        ok: true,
        authed_user: { id: "U_AGENT_FRESH", access_token: "xoxp-FAKE-USER" },
      },
    });

    const res = await request(app)
      .get("/api/messaging/slack/oauth/user/callback")
      .query({ code: "AUTH_CODE", state });
    expect(res.status).toBe(302);
    expect(res.header.location).toMatch(/slack_linked=/);
    expect(res.header.location).toMatch(/\/company\/settings\/messaging/);

    const identities = await db
      .select()
      .from(messagingIdentities)
      .where(eq(messagingIdentities.agentId, agent!.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]!.externalUserRef).toBe("U_AGENT_FRESH");
    expect(identities[0]!.state).toBe("active");
    expect(identities[0]!.authBlobSecretId).toBeTruthy();
  });

  it("start endpoint returns 503 when env is not configured", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: "board-user",
        companyIds: [companyId],
        isInstanceAdmin: true,
      };
      next();
    });
    app.use(
      "/api/messaging/slack",
      messagingSlackRoutes(db, {
        readEnv: () => null,
      }),
    );
    app.use(errorHandler);

    const res = await request(app)
      .get("/api/messaging/slack/oauth/bot/start")
      .query({ companyId });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("messaging_slack_not_configured");
  });
});
