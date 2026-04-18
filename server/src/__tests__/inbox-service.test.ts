import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  authUsers,
  companies,
  issues,
  messagingChannels,
  messagingIdentities,
  projects,
} from "@paperclipai/db";
import {
  autoDiscoverInboxIdentities,
  notifyInbox,
  type SlackInboxApi,
} from "../messaging/inbox.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

const DUMMY_BOT_TOKEN = "xoxb-test";
const DUMMY_TEAM_ID = "T123";

interface Seed {
  companyId: string;
  projectId: string;
  issueId: string;
  userId: string;
  userEmail: string;
}

async function seed(db: ReturnType<typeof createDb>): Promise<Seed> {
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({ name: `Co ${suffix}`, issuePrefix: `CO${suffix}` })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ companyId: company!.id, name: `Proj ${suffix}` })
    .returning();
  const [issue] = await db
    .insert(issues)
    .values({
      companyId: company!.id,
      projectId: project!.id,
      title: "Fix login",
      identifier: `CO${suffix}-1`,
    })
    .returning();
  const userId = `user_${suffix.toLowerCase()}`;
  const userEmail = `alice+${suffix.toLowerCase()}@example.test`;
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: `Alice ${suffix}`,
    email: userEmail,
    createdAt: now,
    updatedAt: now,
  });
  return {
    companyId: company!.id,
    projectId: project!.id,
    issueId: issue!.id,
    userId,
    userEmail,
  };
}

interface FakeApi extends SlackInboxApi {
  calls: { postMessage: number; updateMessage: number; conversationsOpen: number };
  lastPost: { channel?: string; text?: string; blocks?: unknown };
  lastUpdate: { channel?: string; ts?: string; text?: string; blocks?: unknown };
  returnedTs: string;
}

function makeFakeApi(): FakeApi {
  let tsCounter = 1_000;
  const api: FakeApi = {
    calls: { postMessage: 0, updateMessage: 0, conversationsOpen: 0 },
    lastPost: {},
    lastUpdate: {},
    returnedTs: "",
    async usersList() {
      return [];
    },
    async conversationsOpen(_token, userId) {
      api.calls.conversationsOpen += 1;
      return { channelId: `D_${userId}` };
    },
    async postMessage(_token, args) {
      api.calls.postMessage += 1;
      api.lastPost = args;
      tsCounter += 1;
      const ts = `${tsCounter}.000001`;
      api.returnedTs = ts;
      return { ts };
    },
    async updateMessage(_token, args) {
      api.calls.updateMessage += 1;
      api.lastUpdate = args;
    },
  };
  return api;
}

describeIf("inbox service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(messagingIdentities);
    await db.delete(messagingChannels);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("autoDiscoverInboxIdentities", () => {
    it("inserts identities for matched emails and is idempotent", async () => {
      const s = await seed(db);
      const api: SlackInboxApi = {
        async usersList() {
          return [
            { id: "U_ALICE", email: s.userEmail },
            { id: "U_BOB", email: "bob-no-match@example.test" },
            { id: "U_NO_EMAIL", email: null },
          ];
        },
        async conversationsOpen() {
          throw new Error("not used");
        },
        async postMessage() {
          throw new Error("not used");
        },
        async updateMessage() {
          throw new Error("not used");
        },
      };

      const first = await autoDiscoverInboxIdentities(db, {
        companyId: s.companyId,
        botToken: DUMMY_BOT_TOKEN,
        api,
      });
      expect(first).toEqual({ inserted: 1, matched: 1 });

      const rows = await db
        .select()
        .from(messagingIdentities)
        .where(
          and(
            eq(messagingIdentities.companyId, s.companyId),
            eq(messagingIdentities.backend, "slack"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(s.userId);
      expect(rows[0]!.externalUserRef).toBe("U_ALICE");
      expect(rows[0]!.state).toBe("active");

      // Idempotent: re-running finds the match but inserts nothing.
      const second = await autoDiscoverInboxIdentities(db, {
        companyId: s.companyId,
        botToken: DUMMY_BOT_TOKEN,
        api,
      });
      expect(second).toEqual({ inserted: 0, matched: 1 });

      const allRows = await db
        .select()
        .from(messagingIdentities)
        .where(eq(messagingIdentities.companyId, s.companyId));
      expect(allRows).toHaveLength(1);
    });

    it("is case-insensitive on email", async () => {
      const s = await seed(db);
      const api: SlackInboxApi = {
        async usersList() {
          return [{ id: "U_UPPER", email: s.userEmail.toUpperCase() }];
        },
        async conversationsOpen() {
          throw new Error("n/a");
        },
        async postMessage() {
          throw new Error("n/a");
        },
        async updateMessage() {
          throw new Error("n/a");
        },
      };
      const result = await autoDiscoverInboxIdentities(db, {
        companyId: s.companyId,
        botToken: DUMMY_BOT_TOKEN,
        api,
      });
      expect(result.inserted).toBe(1);
    });
  });

  describe("notifyInbox", () => {
    async function seedWithIdentity(): Promise<{ s: Seed; externalUserRef: string }> {
      const s = await seed(db);
      const externalUserRef = "U_ALICE";
      await db.insert(messagingIdentities).values({
        companyId: s.companyId,
        userId: s.userId,
        backend: "slack",
        externalUserRef,
        state: "active",
      });
      return { s, externalUserRef };
    }

    it("posts a new message the first time, then edits within the 2-minute window", async () => {
      const { s } = await seedWithIdentity();
      const api = makeFakeApi();

      const nowBase = Date.UTC(2026, 3, 17, 12, 0, 0);
      const firstRes = await notifyInbox(db, {
        userId: s.userId,
        companyId: s.companyId,
        event: { kind: "assignment", issueId: s.issueId, fromAgentName: "ops-bot" },
        api,
        nowMs: () => nowBase,
        workspace: { botToken: DUMMY_BOT_TOKEN, teamId: DUMMY_TEAM_ID },
      });
      expect(firstRes.posted).toBe(true);
      expect(firstRes.edited).toBe(false);
      expect(api.calls.postMessage).toBe(1);
      expect(api.calls.updateMessage).toBe(0);
      expect(api.calls.conversationsOpen).toBe(1);
      expect(api.lastPost.channel).toBe("D_U_ALICE");

      const [channel] = await db
        .select()
        .from(messagingChannels)
        .where(
          and(
            eq(messagingChannels.companyId, s.companyId),
            eq(messagingChannels.purpose, "inbox"),
            eq(messagingChannels.userId, s.userId),
          ),
        );
      expect(channel!.externalChannelRef).toBe("D_U_ALICE");
      const meta = channel!.metadata as Record<string, unknown>;
      expect(meta.lastIssueId).toBe(s.issueId);
      expect(typeof meta.lastPostedExternalRef).toBe("string");

      // Second event 90 seconds later on the same issue: should edit.
      const secondRes = await notifyInbox(db, {
        userId: s.userId,
        companyId: s.companyId,
        event: { kind: "mention", issueId: s.issueId, fromDisplayName: "bob", commentRefId: "r1" },
        api,
        nowMs: () => nowBase + 90_000,
        workspace: { botToken: DUMMY_BOT_TOKEN, teamId: DUMMY_TEAM_ID },
      });
      expect(secondRes.posted).toBe(false);
      expect(secondRes.edited).toBe(true);
      expect(api.calls.postMessage).toBe(1);
      expect(api.calls.updateMessage).toBe(1);
      expect(api.calls.conversationsOpen).toBe(1); // DM reused
      expect(api.lastUpdate.ts).toBe(api.returnedTs);

      // Third event well beyond the sliding 2-minute window relative to the
      // previous update: should be a fresh post.
      const thirdRes = await notifyInbox(db, {
        userId: s.userId,
        companyId: s.companyId,
        event: { kind: "status_change", issueId: s.issueId, newStatus: "done" },
        api,
        nowMs: () => nowBase + 90_000 + 3 * 60 * 1000,
        workspace: { botToken: DUMMY_BOT_TOKEN, teamId: DUMMY_TEAM_ID },
      });
      expect(thirdRes.posted).toBe(true);
      expect(thirdRes.edited).toBe(false);
      expect(api.calls.postMessage).toBe(2);
      expect(api.calls.updateMessage).toBe(1);
    });

    it("respects subscription preferences", async () => {
      const { s } = await seedWithIdentity();
      await db
        .update(messagingIdentities)
        .set({ inboxPreferences: { assignment: false } })
        .where(
          and(
            eq(messagingIdentities.companyId, s.companyId),
            eq(messagingIdentities.userId, s.userId),
          ),
        );

      const api = makeFakeApi();
      const res = await notifyInbox(db, {
        userId: s.userId,
        companyId: s.companyId,
        event: { kind: "assignment", issueId: s.issueId },
        api,
        workspace: { botToken: DUMMY_BOT_TOKEN, teamId: DUMMY_TEAM_ID },
      });
      expect(res.posted).toBe(false);
      expect(res.edited).toBe(false);
      expect(res.reason).toBe("pref_disabled");
      expect(api.calls.postMessage).toBe(0);
      expect(api.calls.updateMessage).toBe(0);

      // Different kind still fires.
      const res2 = await notifyInbox(db, {
        userId: s.userId,
        companyId: s.companyId,
        event: { kind: "mention", issueId: s.issueId, fromDisplayName: "x", commentRefId: "r2" },
        api,
        workspace: { botToken: DUMMY_BOT_TOKEN, teamId: DUMMY_TEAM_ID },
      });
      expect(res2.posted).toBe(true);
    });

    it("no-ops when no identity exists", async () => {
      const s = await seed(db);
      const api = makeFakeApi();
      const spy = vi.spyOn(api, "postMessage");
      const res = await notifyInbox(db, {
        userId: s.userId,
        companyId: s.companyId,
        event: { kind: "assignment", issueId: s.issueId },
        api,
        workspace: { botToken: DUMMY_BOT_TOKEN, teamId: DUMMY_TEAM_ID },
      });
      expect(res.posted).toBe(false);
      expect(res.reason).toBe("no_identity");
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
