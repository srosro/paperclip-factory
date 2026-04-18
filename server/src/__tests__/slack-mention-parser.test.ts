import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  agents,
  messagingIdentities,
} from "@paperclipai/db";
import {
  toExternalMentions,
  toInternalMentions,
} from "../messaging/adapters/slack/mention-parser.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

describeIf("slack mention parser", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let aliceAgentId = "";
  let bobAgentId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-mentions-");
    db = createDb(tempDb.connectionString);
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({ name: `Co ${suffix}`, issuePrefix: `CM${suffix}` })
      .returning();
    companyId = company!.id;
    const [alice] = await db
      .insert(agents)
      .values({ companyId, name: "claudecoder" })
      .returning();
    aliceAgentId = alice!.id;
    const [bob] = await db
      .insert(agents)
      .values({ companyId, name: "codexcoder" })
      .returning();
    bobAgentId = bob!.id;
    await db.insert(messagingIdentities).values([
      {
        companyId,
        agentId: aliceAgentId,
        backend: "slack",
        externalUserRef: "U_ALICE",
        state: "active",
      },
      {
        companyId,
        agentId: bobAgentId,
        backend: "slack",
        externalUserRef: "U_BOB",
        state: "active",
      },
    ]);
  }, 30_000);

  afterEach(async () => {
    // No-op — fixtures persist across the whole suite.
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rewrites @name to <@Uxxx> for known agents", async () => {
    const out = await toExternalMentions(
      db,
      companyId,
      "@claudecoder please review with @codexcoder",
    );
    expect(out).toBe("<@U_ALICE> please review with <@U_BOB>");
  });

  it("leaves unknown names as literal text", async () => {
    const out = await toExternalMentions(db, companyId, "@nobody hey");
    expect(out).toBe("@nobody hey");
  });

  it("rewrites <@Uxxx> back to @name and returns mentioned agent ids", async () => {
    const result = await toInternalMentions(db, "<@U_ALICE> look at this");
    expect(result.rewritten).toBe("@claudecoder look at this");
    expect(result.mentionedAgentIds).toContain(aliceAgentId);
  });

  it("returns both agent ids for a body mentioning both", async () => {
    const result = await toInternalMentions(
      db,
      "<@U_ALICE> and <@U_BOB> both, please",
    );
    expect(result.rewritten).toBe("@claudecoder and @codexcoder both, please");
    expect(result.mentionedAgentIds.sort()).toEqual(
      [aliceAgentId, bobAgentId].sort(),
    );
  });

  it("leaves unresolvable refs as-is with no mentioned ids", async () => {
    const result = await toInternalMentions(db, "<@U_UNKNOWN> hi");
    expect(result.rewritten).toBe("<@U_UNKNOWN> hi");
    expect(result.mentionedAgentIds).toEqual([]);
  });
});
