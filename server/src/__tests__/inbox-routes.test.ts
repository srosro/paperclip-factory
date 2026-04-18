import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  authUsers,
  companies,
  messagingIdentities,
} from "@paperclipai/db";
import { messagingInboxRoutes } from "../routes/messaging-inbox.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

interface Seed {
  companyId: string;
  userId: string;
}

async function seed(db: ReturnType<typeof createDb>): Promise<Seed> {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({ name: `Co ${suffix}`, issuePrefix: `CO${suffix}` })
    .returning();
  const userId = `user_${suffix.toLowerCase()}`;
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: `Alice ${suffix}`,
    email: `alice+${suffix.toLowerCase()}@example.test`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messagingIdentities).values({
    companyId: company!.id,
    userId,
    backend: "slack",
    externalUserRef: `U_${suffix}`,
    state: "active",
    inboxPreferences: { assignment: false },
  });
  return { companyId: company!.id, userId };
}

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
  app.use("/api/messaging", messagingInboxRoutes(db));
  app.use(errorHandler);
  return app;
}

describeIf("inbox routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(messagingIdentities);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("GET /inbox-prefs returns merged defaults for the caller's identity", async () => {
    const s = await seed(db);
    const app = buildApp(db, {
      type: "board",
      userId: s.userId,
      companyIds: [s.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get(`/api/messaging/inbox-prefs?companyId=${s.companyId}`);

    expect(res.status).toBe(200);
    expect(res.body.prefs).toMatchObject({
      assignment: false,
      mention: true,
      approval_requested: true,
      status_change: true,
      watching: false,
    });
  });

  it("PATCH /inbox-prefs merges updates", async () => {
    const s = await seed(db);
    const app = buildApp(db, {
      type: "board",
      userId: s.userId,
      companyIds: [s.companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/messaging/inbox-prefs`)
      .send({ companyId: s.companyId, prefs: { mention: false, watching: true } });

    expect(res.status).toBe(200);
    expect(res.body.prefs).toMatchObject({
      assignment: false,
      mention: false,
      approval_requested: true,
      status_change: true,
      watching: true,
    });

    const getRes = await request(app)
      .get(`/api/messaging/inbox-prefs?companyId=${s.companyId}`);
    expect(getRes.body.prefs).toMatchObject({
      assignment: false,
      mention: false,
      watching: true,
    });
  });

  it("rejects non-board actors", async () => {
    const s = await seed(db);
    const app = buildApp(db, {
      type: "agent",
      agentId: "a1",
      companyId: s.companyId,
    });
    const res = await request(app)
      .get(`/api/messaging/inbox-prefs?companyId=${s.companyId}`);
    expect(res.status).toBe(403);
  });

  it("rejects missing companyId", async () => {
    const s = await seed(db);
    const app = buildApp(db, {
      type: "board",
      userId: s.userId,
      companyIds: [s.companyId],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app).get(`/api/messaging/inbox-prefs`);
    expect(res.status).toBe(400);
  });
});
