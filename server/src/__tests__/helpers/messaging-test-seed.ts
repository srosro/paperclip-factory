import { and, eq } from "drizzle-orm";
import {
  authUsers,
  issueCommentRefs,
  issues as issuesTable,
  messagingIdentities,
  type Db as SchemaDb,
} from "@paperclipai/db";
import {
  initMessaging,
  invalidateMessagingContext,
  requireMessagingContext,
  resetMessagingForTests,
} from "../../messaging/index.js";

type Db = SchemaDb extends infer _ ? any : never;

async function ensureAuthUser(db: Db, userId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(authUsers)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@example.test`,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: authUsers.id });
}

export async function ensureTestMessaging(db: Db): Promise<void> {
  resetMessagingForTests();
  initMessaging({ db, testFallbackBackend: "fake" });
}

export function resetTestMessagingCache(companyId: string): void {
  invalidateMessagingContext(companyId);
}

export async function seedMessagingIdentity(
  db: Db,
  args: {
    companyId: string;
    agentId?: string;
    userId?: string;
    externalUserRef?: string;
  },
): Promise<string> {
  if (!args.agentId && !args.userId) {
    throw new Error("seedMessagingIdentity requires agentId or userId");
  }
  if (args.userId) {
    await ensureAuthUser(db, args.userId);
  }
  const principal = args.agentId ?? args.userId ?? "anon";
  const externalUserRef =
    args.externalUserRef ??
    `U_${args.companyId.slice(0, 8)}_${principal.slice(0, 12)}`;

  const where = args.agentId
    ? and(
        eq(messagingIdentities.companyId, args.companyId),
        eq(messagingIdentities.backend, "fake"),
        eq(messagingIdentities.agentId, args.agentId),
      )
    : and(
        eq(messagingIdentities.companyId, args.companyId),
        eq(messagingIdentities.backend, "fake"),
        eq(messagingIdentities.userId, args.userId!),
      );
  const existing = await db.select().from(messagingIdentities).where(where).limit(1);
  if (existing[0]) return existing[0].id;

  const [row] = await db
    .insert(messagingIdentities)
    .values({
      companyId: args.companyId,
      agentId: args.agentId ?? null,
      userId: args.userId ?? null,
      backend: "fake",
      externalUserRef,
      state: "active",
    })
    .returning();
  return row!.id;
}

/**
 * Seed an issue_comment_refs row for a given (companyId, issueId). Ensures
 * the issue has a linear_issue_id so the router can resolve live bodies
 * from the FakeAdapter. Returns the new ref id.
 */
export async function seedIssueComment(
  db: Db,
  args: {
    id?: string;
    companyId: string;
    issueId: string;
    authorAgentId?: string | null;
    authorUserId?: string | null;
    body: string;
    createdByRunId?: string | null;
    createdAt?: Date | null;
    deletedAt?: Date | null;
  },
): Promise<string> {
  // Ensure the issue has a linearIssueId so the router can round-trip.
  const issueRow = await db
    .select({
      id: issuesTable.id,
      linearIssueId: issuesTable.linearIssueId,
    })
    .from(issuesTable)
    .where(eq(issuesTable.id, args.issueId))
    .then((rows: Array<{ id: string; linearIssueId: string | null }>) => rows[0]);
  if (!issueRow) {
    throw new Error(`seedIssueComment: issue ${args.issueId} not found`);
  }
  let externalIssueRef = issueRow.linearIssueId;
  if (!externalIssueRef) {
    externalIssueRef = crypto.randomUUID();
    await db
      .update(issuesTable)
      .set({
        linearIssueId: externalIssueRef,
        linearIssueIdentifier: `FAKE-${args.issueId.slice(0, 6)}`,
      })
      .where(eq(issuesTable.id, args.issueId));
  }

  if (args.authorUserId) await ensureAuthUser(db, args.authorUserId);

  const externalMessageRef = `M_test_${Math.random().toString(36).slice(2, 10)}`;
  const [refRow] = await db
    .insert(issueCommentRefs)
    .values({
      ...(args.id ? { id: args.id } : {}),
      issueId: args.issueId,
      backend: "fake",
      externalMessageRef,
      authorAgentId: args.authorAgentId ?? null,
      authorUserId: args.authorUserId ?? null,
      createdByRunId: args.createdByRunId ?? null,
      firstSeenAt: args.createdAt ?? new Date(),
      deletedAt: args.deletedAt ?? null,
    })
    .returning();

  // Register the body with the FakeAdapter so router.getComments surfaces it.
  const ctx = await requireMessagingContext(args.companyId);
  const fakeAdapter = ctx.adapter;
  if (
    "seedComment" in fakeAdapter &&
    typeof (fakeAdapter as { seedComment?: unknown }).seedComment === "function"
  ) {
    (fakeAdapter as unknown as {
      seedComment: (a: {
        ref: string;
        externalIssueRef: string;
        author: string;
        body: string;
        createdAt?: Date;
      }) => void;
    }).seedComment({
      ref: externalMessageRef,
      externalIssueRef,
      author: args.authorAgentId ?? args.authorUserId ?? "SYSTEM",
      body: args.body,
      createdAt: args.createdAt ?? new Date(),
    });
  }

  return refRow!.id;
}

/**
 * Post a comment through the router, ensuring the issue has a linearIssueId
 * and the author identity is seeded + active. Returns the comment ref id.
 */
export async function postTestComment(
  db: Db,
  args: {
    companyId: string;
    issueId: string;
    authorAgentId?: string;
    authorUserId?: string;
    body: string;
    createdByRunId?: string;
  },
): Promise<string> {
  await seedMessagingIdentity(db, {
    companyId: args.companyId,
    agentId: args.authorAgentId,
    userId: args.authorUserId,
  });
  // Ensure the cached issue has a linearIssueId so the router can resolve.
  const issueRow = await db
    .select({
      id: issuesTable.id,
      linearIssueId: issuesTable.linearIssueId,
    })
    .from(issuesTable)
    .where(eq(issuesTable.id, args.issueId))
    .then((rows: Array<{ id: string; linearIssueId: string | null }>) => rows[0]);
  if (!issueRow) {
    throw new Error(`postTestComment: issue ${args.issueId} not found`);
  }
  if (!issueRow.linearIssueId) {
    await db
      .update(issuesTable)
      .set({
        linearIssueId: crypto.randomUUID(),
        linearIssueIdentifier: `FAKE-${args.issueId.slice(0, 6)}`,
      })
      .where(eq(issuesTable.id, args.issueId));
  }

  const ctx = await requireMessagingContext(args.companyId);
  const posted = await ctx.router.postComment({
    companyId: args.companyId,
    issueId: args.issueId,
    authorAgentId: args.authorAgentId,
    authorUserId: args.authorUserId,
    body: args.body,
    createdByRunId: args.createdByRunId,
  });
  return posted.id;
}

/**
 * Delete all messaging fixture rows. Call from test afterEach where the
 * suite previously cleared per-test state.
 */
export async function clearMessagingFixtures(db: Db): Promise<void> {
  await db.delete(issueCommentRefs);
  await db.delete(messagingIdentities);
}
