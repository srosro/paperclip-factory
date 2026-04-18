// One-shot: wipe the SAM-1 dead tree, create the plow-dev project, seed a
// starter issue assigned to CEO, and post the first comment from CEO to
// provision the real Slack channel.
//
//   pnpm --filter @paperclipai/server exec tsx scripts/plow-dev-bootstrap.ts
import { and, eq } from "drizzle-orm";
import {
  agents as agentsTable,
  createDb,
  issues,
  messagingChannels,
  messagingIdentities,
  messagingThreads,
  projects,
} from "@paperclipai/db";
import {
  defaultSlackResolvers,
  initMessaging,
  requireMessagingContext,
} from "../src/messaging/index.js";

const COMPANY_ID = "9ec08c8f-e0df-4a6c-a1ec-db3b93615665";
const SAM_1_ID = "0f2b1766-b80f-4cb7-b3b2-72cd454e4f77";
const RELEASE_BUILDER_ID = "7259ba52-0537-43d5-b5d0-979fed1d81f1";
const CEO_ID = "9f6e9a34-6876-433f-bdb9-1a5ce24a44fe";

const db = createDb("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
initMessaging({ db, slack: defaultSlackResolvers(db) });
const ctx = await requireMessagingContext(COMPANY_ID);

console.log("[1/6] Cancel SAM-1 + soft-lock its thread");
await db.transaction(async (tx) => {
  await tx.update(issues).set({ status: "cancelled", updatedAt: new Date() }).where(eq(issues.id, SAM_1_ID));
  await tx.update(messagingThreads).set({ state: "locked", updatedAt: new Date() }).where(eq(messagingThreads.issueId, SAM_1_ID));
});

console.log("[2/6] Archive the old ad-hoc channel in Slack");
const [oldChannel] = await db
  .select()
  .from(messagingChannels)
  .where(
    and(
      eq(messagingChannels.companyId, COMPANY_ID),
      eq(messagingChannels.purpose, "ad_hoc"),
    ),
  )
  .limit(1);
if (oldChannel) {
  try {
    await ctx.adapter.archiveChannel(oldChannel.externalChannelRef);
    await db
      .update(messagingChannels)
      .set({ state: "archived", updatedAt: new Date() })
      .where(eq(messagingChannels.id, oldChannel.id));
    console.log("   archived:", oldChannel.externalChannelName);
  } catch (err) {
    console.log("   archive warning (continuing):", (err as Error).message);
  }
}

console.log("[3/6] Terminate release-builder agent");
await db
  .update(agentsTable)
  .set({ status: "terminated", updatedAt: new Date() })
  .where(eq(agentsTable.id, RELEASE_BUILDER_ID));

console.log("[4/6] Create project plow-dev");
const [project] = await db
  .insert(projects)
  .values({
    companyId: COMPANY_ID,
    name: "plow-dev",
    status: "active",
  })
  .returning();
console.log("   project id:", project!.id);

console.log("[5/6] Create starter issue assigned to CEO");
const [issue] = await db
  .insert(issues)
  .values({
    companyId: COMPANY_ID,
    projectId: project!.id,
    assigneeAgentId: CEO_ID,
    title: "Bootstrap plow-dev with agent-first workflow",
    description:
      "Fresh issue to exercise the Slack-first comms loop end to end. Reply in the thread to wake the assignee. CEO owns initial direction; eng-mgr manages execution through tech-lead and developer.",
    status: "todo",
    priority: "medium",
    identifier: "SAM-2",
  })
  .returning();
console.log("   issue id:", issue!.id, "identifier:", issue!.identifier);

console.log("[6/6] Post first comment from CEO (provisions #proj-plow-dev)");
const posted = await ctx.router.postMessage({
  companyId: COMPANY_ID,
  issueId: issue!.id,
  projectId: project!.id,
  authorAgentId: CEO_ID,
  body:
    "Team — we're resetting around Slack-first comms. This issue is our smoke test. " +
    "Reply in this thread to wake me. I'll delegate execution down through eng-mgr / tech-lead / developer once the team's runtime is wired up.",
});
console.log("   ref id:", posted.id, "ts:", posted.externalMessageRef);

// Invite all linked agents to the new channel so their tokens can post.
const [newChannel] = await db
  .select()
  .from(messagingChannels)
  .where(eq(messagingChannels.projectId, project!.id))
  .limit(1);
if (newChannel) {
  const linkedIdentities = await db
    .select({ externalUserRef: messagingIdentities.externalUserRef })
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.companyId, COMPANY_ID),
        eq(messagingIdentities.backend, "slack"),
        eq(messagingIdentities.state, "active"),
      ),
    );
  for (const row of linkedIdentities) {
    try {
      await ctx.adapter.addChannelMember(
        newChannel.externalChannelRef,
        row.externalUserRef,
      );
      console.log("   invited", row.externalUserRef);
    } catch (err) {
      console.log("   invite warning:", row.externalUserRef, (err as Error).message);
    }
  }
}

console.log("\nDone. Go to Slack → #proj-plow-dev and look at the SAM-2 thread.");
process.exit(0);
