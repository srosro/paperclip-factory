import { and, eq, sql } from "drizzle-orm";
import {
  authUsers,
  messagingChannels,
  messagingIdentities,
  messagingMessageRefs,
  messagingThreads,
  projects,
  type Db as SchemaDb,
} from "@paperclipai/db";
import {
  getMessagingRouter,
  initMessaging,
  messagingRegistry,
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

// Re-initialize messaging for each test run with a fresh FakeAdapter echo.
export function ensureTestMessaging(db: Db): void {
  // Force a fresh adapter so per-test state does not leak across suites.
  try {
    messagingRegistry.unregister("fake");
  } catch {
    // no-op
  }
  resetMessagingForTests();
  initMessaging({ db });
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
  // Scope externalUserRef by companyId so fixtures across companies don't
  // collide on the (backend, externalUserRef) unique index.
  const principal = args.agentId ?? args.userId ?? "anon";
  const externalUserRef =
    args.externalUserRef ??
    `U_${args.companyId.slice(0, 8)}_${principal.slice(0, 12)}`;

  // Skip if already present for this (companyId, backend, agent|user).
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
 * Seed a messaging_message_refs row for a given (companyId, issueId), creating
 * the channel + thread on demand. Registers the body with the FakeAdapter so
 * `router.getThreadMessages` returns it. Returns the new ref id (which is the
 * value the legacy tests treated as `issueComments.id`).
 */
export async function seedMessagingComment(
  db: Db,
  args: {
    id?: string;
    companyId: string;
    issueId: string;
    projectId?: string | null;
    authorAgentId?: string | null;
    authorUserId?: string | null;
    body: string;
    createdByRunId?: string | null;
    createdAt?: Date | null;
    deletedAt?: Date | null;
  },
): Promise<string> {
  // Ensure channel exists for the project (or a synthetic one if no project).
  let channelId: string;
  const projectId = args.projectId ?? null;
  if (projectId) {
    const existingChannel = await db
      .select()
      .from(messagingChannels)
      .where(
        and(
          eq(messagingChannels.companyId, args.companyId),
          eq(messagingChannels.backend, "fake"),
          eq(messagingChannels.projectId, projectId),
        ),
      )
      .limit(1);
    if (existingChannel[0]) {
      channelId = existingChannel[0].id;
    } else {
      const [newChannel] = await db
        .insert(messagingChannels)
        .values({
          companyId: args.companyId,
          backend: "fake",
          purpose: "project",
          projectId,
          externalChannelRef: `C_test_${projectId.slice(0, 8)}`,
          externalChannelName: `proj-${projectId.slice(0, 6)}`,
        })
        .returning();
      channelId = newChannel!.id;
    }
  } else {
    // ad_hoc channel for tests that don't set projectId
    const adhocRef = `C_adhoc_${args.issueId.slice(0, 8)}`;
    const existingChannel = await db
      .select()
      .from(messagingChannels)
      .where(
        and(
          eq(messagingChannels.backend, "fake"),
          eq(messagingChannels.externalChannelRef, adhocRef),
        ),
      )
      .limit(1);
    if (existingChannel[0]) {
      channelId = existingChannel[0].id;
    } else {
      const [newChannel] = await db
        .insert(messagingChannels)
        .values({
          companyId: args.companyId,
          backend: "fake",
          purpose: "ad_hoc",
          externalChannelRef: adhocRef,
          externalChannelName: `adhoc-${args.issueId.slice(0, 6)}`,
        })
        .returning();
      channelId = newChannel!.id;
    }
  }

  let threadId: string;
  let threadRef: string;
  let channelRef: string;
  {
    const channelRow = await db
      .select()
      .from(messagingChannels)
      .where(eq(messagingChannels.id, channelId))
      .limit(1);
    channelRef = channelRow[0]!.externalChannelRef;
  }
  const existingThread = await db
    .select()
    .from(messagingThreads)
    .where(eq(messagingThreads.issueId, args.issueId))
    .limit(1);
  if (existingThread[0]) {
    threadId = existingThread[0].id;
    threadRef = existingThread[0].externalThreadRef;
  } else {
    threadRef = `M_thread_${args.issueId.slice(0, 8)}`;
    const [newThread] = await db
      .insert(messagingThreads)
      .values({
        issueId: args.issueId,
        channelId,
        backend: "fake",
        externalThreadRef: threadRef,
        parentMessageRef: threadRef,
      })
      .returning();
    threadId = newThread!.id;
  }

  const externalMessageRef = `M_test_${Math.random().toString(36).slice(2, 10)}`;
  if (args.authorUserId) await ensureAuthUser(db, args.authorUserId);
  const [refRow] = await db
    .insert(messagingMessageRefs)
    .values({
      ...(args.id ? { id: args.id } : {}),
      threadId,
      backend: "fake",
      externalMessageRef,
      authorAgentId: args.authorAgentId ?? null,
      authorUserId: args.authorUserId ?? null,
      createdByRunId: args.createdByRunId ?? null,
      firstSeenAt: args.createdAt ?? new Date(),
      deletedAt: args.deletedAt ?? null,
    })
    .returning();

  // Register the body with the FakeAdapter so router.getThreadMessages can
  // surface it alongside the ref row.
  const fakeAdapter = messagingRegistry.get("fake");
  if (
    fakeAdapter &&
    "seedMessage" in fakeAdapter &&
    typeof (fakeAdapter as { seedMessage?: unknown }).seedMessage === "function"
  ) {
    (fakeAdapter as unknown as {
      seedMessage: (a: {
        ref: string;
        channelRef: string;
        threadRef: string;
        author: string;
        body: string;
        createdAt?: Date;
      }) => void;
    }).seedMessage({
      ref: externalMessageRef,
      channelRef,
      threadRef,
      author: args.authorAgentId ?? args.authorUserId ?? "SYSTEM",
      body: args.body,
      createdAt: args.createdAt ?? new Date(),
    });
  }

  return refRow!.id;
}

/**
 * Like seedMessagingComment but goes through the router's postMessage path,
 * which registers the body with the FakeAdapter so future router reads
 * (router.getThreadMessages) see the body. Requires a seeded identity and
 * the issue's project id so the router can create/reuse the channel.
 * Returns the message ref id.
 */
export async function postTestComment(
  db: Db,
  args: {
    companyId: string;
    issueId: string;
    projectId: string;
    authorAgentId?: string;
    authorUserId?: string;
    body: string;
    createdByRunId?: string;
  },
): Promise<string> {
  // Ensure identity exists and is active.
  await seedMessagingIdentity(db, {
    companyId: args.companyId,
    agentId: args.authorAgentId,
    userId: args.authorUserId,
  });
  const router = getMessagingRouter();
  const posted = await router.postMessage({
    companyId: args.companyId,
    issueId: args.issueId,
    projectId: args.projectId,
    authorAgentId: args.authorAgentId,
    authorUserId: args.authorUserId,
    body: args.body,
    createdByRunId: args.createdByRunId,
  });
  return posted.id;
}

/**
 * Delete all messaging fixture rows. Call from test afterEach where the
 * suite previously called `db.delete(issueComments)`.
 */
export async function clearMessagingFixtures(db: Db): Promise<void> {
  void projects;
  void sql;
  await db.delete(messagingMessageRefs);
  await db.delete(messagingThreads);
  await db.delete(messagingChannels);
  await db.delete(messagingIdentities);
}
