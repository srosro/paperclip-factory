import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  messagingIdentities,
  messagingWorkspaceInstall,
} from "@paperclipai/db";
import { messagingAdminRoutes } from "../routes/messaging-admin.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

function buildApp(
  db: ReturnType<typeof createDb>,
  actor: Record<string, unknown>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", messagingAdminRoutes(db));
  app.use(errorHandler);
  return app;
}

describeIf("messaging admin status endpoint", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-messaging-status-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  let companyId!: string;
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Status Co",
      issuePrefix: `SC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
  });

  afterEach(async () => {
    await db.delete(messagingIdentities);
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

  function boardActor(companyIds: string[]) {
    return {
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds,
      isInstanceAdmin: false,
    };
  }

  it("returns installed=false and no agents when no install exists", async () => {
    const app = buildApp(db, boardActor([companyId]));
    const res = await request(app).get(
      `/api/companies/${companyId}/messaging/status`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      installed: false,
      workspaceName: null,
      workspaceRef: null,
      agentIdentities: [],
    });
  });

  it("reports installed workspace and agent identity states", async () => {
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
      workspaceName: "Paperclip Test",
      botUserRef: "U_BOT",
      botTokenSecretId: botSecret!.id,
      signingSecretId: signingSecret!.id,
      state: "active",
    });

    const [agentActive] = await db
      .insert(agents)
      .values({ companyId, name: "alpha" })
      .returning();
    const [agentPending] = await db
      .insert(agents)
      .values({ companyId, name: "bravo" })
      .returning();
    const [agentRevoked] = await db
      .insert(agents)
      .values({ companyId, name: "charlie" })
      .returning();
    await db
      .insert(agents)
      .values({ companyId, name: "zulu", status: "terminated" });

    await db.insert(messagingIdentities).values({
      companyId,
      agentId: agentActive!.id,
      backend: "slack",
      externalUserRef: "U_ALPHA",
      state: "active",
    });
    await db.insert(messagingIdentities).values({
      companyId,
      agentId: agentRevoked!.id,
      backend: "slack",
      externalUserRef: "U_CHARLIE",
      state: "revoked",
    });

    const app = buildApp(db, boardActor([companyId]));
    const res = await request(app).get(
      `/api/companies/${companyId}/messaging/status`,
    );
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.workspaceName).toBe("Paperclip Test");
    expect(res.body.workspaceRef).toBe("T_WS1");

    const names = (res.body.agentIdentities as Array<{ agentName: string; state: string }>).map(
      (row) => [row.agentName, row.state],
    );
    expect(names).toEqual([
      ["alpha", "active"],
      ["bravo", "pending_auth"],
      ["charlie", "revoked"],
    ]);
    // Terminated agent must not appear.
    expect(names.some(([n]) => n === "zulu")).toBe(false);
    // Reference the pending agent id so TS doesn't flag it as unused.
    expect(typeof agentPending!.id).toBe("string");
  });

  it("rejects non-board actors", async () => {
    const app = buildApp(db, {
      type: "agent",
      agentId: "a1",
      companyId,
    });
    const res = await request(app).get(
      `/api/companies/${companyId}/messaging/status`,
    );
    expect(res.status).toBe(403);
  });

  it("rejects board actors without company access", async () => {
    const app = buildApp(db, boardActor([randomUUID()]));
    const res = await request(app).get(
      `/api/companies/${companyId}/messaging/status`,
    );
    expect(res.status).toBe(403);
  });
});
