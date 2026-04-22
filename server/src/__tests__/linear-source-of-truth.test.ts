import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll, afterEach, beforeAll, describe, expect, it,
} from "vitest";
import {
  agents, companies, createDb, issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { syncFromLinearEvent } from "../messaging/adapters/linear/cache-sync.js";

import { normalizeLinearEvent } from "../messaging/adapters/linear/events-normalize.js";

describe("normalizeLinearEvent — issue_updated full snapshot", () => {
  it("carries title, description, and priority from the webhook payload", () => {
    const raw = {
      webhookId: "wh1",
      webhookTimestamp: 1000,
      type: "Issue",
      action: "update",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedFrom: { stateId: "old-state" },
      data: {
        id: "LIN-1",
        identifier: "PLO-1",
        title: "Updated title",
        description: "Updated desc",
        priority: 2,
        assignee: null,
        state: { id: "state-in-progress" },
      },
    };
    const event = normalizeLinearEvent(raw);
    expect(event?.kind).toBe("issue_updated");
    if (event?.kind !== "issue_updated") throw new Error("wrong kind");
    expect(event.title).toBe("Updated title");
    expect(event.description).toBe("Updated desc");
    expect(event.priority).toBe(2);
    expect(event.stateExternalRef).toBe("state-in-progress");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeIf = embeddedPostgresSupport.supported ? describe : describe.skip;

describeIf("cache-sync full field sync", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sot-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  it("resolveMessagingContext returns 'disabled' for a company with no messaging config", async () => {
    const [company] = await db.insert(companies)
      .values({ name: "No Linear Co", issuePrefix: "NLC" })
      .returning();

    const { resolveMessagingContext, initMessaging, resetMessagingForTests } = await import("../messaging/context.js");
    resetMessagingForTests();
    initMessaging({ db });
    try {
      const ctx = await resolveMessagingContext(company!.id);
      expect(ctx.status).toBe("disabled");
    } finally {
      resetMessagingForTests();
    }
  });

  it("route-level gate: requireMessagingContext throws MessagingNotConfigured → translateMessagingError maps it to 412", async () => {
    // This tests the chain wired in the POST /companies/:companyId/issues handler:
    //   requireMessagingContext(companyId).catch(err => { throw translateMessagingError(err) })
    // Full HTTP route tests would need an authenticated Express app; instead we exercise
    // the two halves directly. Integration coverage of the actual route guard is provided
    // by the e2e fake-adapter smoke test in messaging-e2e.test.ts.
    const [company] = await db.insert(companies)
      .values({ name: "Gate Co", issuePrefix: "GTC" })
      .returning();

    const { requireMessagingContext, initMessaging, resetMessagingForTests } = await import("../messaging/context.js");
    const { translateMessagingError, HttpError } = await import("../errors.js");
    resetMessagingForTests();
    initMessaging({ db });
    try {
      await expect(requireMessagingContext(company!.id)).rejects.toThrow("messaging not configured");

      const { MessagingNotConfigured } = await import("../messaging/types.js");
      const translated = translateMessagingError(new MessagingNotConfigured(company!.id));
      expect(translated).toBeInstanceOf(HttpError);
      expect((translated as HttpError).status).toBe(412);
      expect((translated as HttpError).details).toMatchObject({ code: "messaging_not_configured" });
    } finally {
      resetMessagingForTests();
    }
  });

  it("syncs title, status, and priority from issue_updated event", async () => {
    const [company] = await db.insert(companies)
      .values({ name: "Test Co", issuePrefix: "TST" })
      .returning();
    const [project] = await db.insert(projects)
      .values({ companyId: company!.id, name: "P" })
      .returning();
    const linearIssueId = randomUUID();
    await db.insert(issues).values({
      companyId: company!.id,
      projectId: project!.id,
      linearIssueId,
      linearIssueIdentifier: "TST-1",
    });

    const stateId = randomUUID();
    const workflowStateMap = {
      kind: "complete" as const,
      byStatus: {
        todo: randomUUID(),
        in_progress: stateId,
        in_review: randomUUID(),
        blocked: randomUUID(),
        done: randomUUID(),
        cancelled: randomUUID(),
      },
    };

    await syncFromLinearEvent(
      { db, companyId: company!.id, workflowStateMap },
      {
        kind: "issue_updated",
        externalEventId: "EV1",
        externalIssueRef: linearIssueId,
        changedFields: ["title", "stateId", "priority"],
        title: "New title",
        description: null,
        priority: 2,
        stateExternalRef: stateId,
        updatedAt: new Date(),
      },
    );

    const [row] = await db.select().from(issues)
      .where(eq(issues.linearIssueId, linearIssueId));
    // title/priority columns dropped in Task 3 — Linear is now source of truth.
    // Status is expressed via sidecar timestamps: in_progress → startedAt set.
    expect(row!.linearIssueIdentifier).toBe("TST-1");
    expect(row!.startedAt).not.toBeNull();
    expect(row!.completedAt).toBeNull();
    expect(row!.cancelledAt).toBeNull();
  });
});
