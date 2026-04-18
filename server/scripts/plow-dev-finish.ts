// Resume the bootstrap from just-after the channel got created: invite all
// linked identities, then post CEO's first comment.
import { and, eq } from "drizzle-orm";
import {
  createDb,
  issues,
  messagingChannels,
  messagingIdentities,
  projects,
} from "@paperclipai/db";
import {
  defaultSlackResolvers,
  initMessaging,
  requireMessagingContext,
} from "../src/messaging/index.js";

const COMPANY_ID = "9ec08c8f-e0df-4a6c-a1ec-db3b93615665";
const CEO_ID = "9f6e9a34-6876-433f-bdb9-1a5ce24a44fe";

const db = createDb("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
initMessaging({ db, slack: defaultSlackResolvers(db) });
const ctx = await requireMessagingContext(COMPANY_ID);

const [project] = await db
  .select()
  .from(projects)
  .where(and(eq(projects.companyId, COMPANY_ID), eq(projects.name, "plow-dev")))
  .limit(1);
if (!project) throw new Error("plow-dev project not found");

const [channel] = await db
  .select()
  .from(messagingChannels)
  .where(eq(messagingChannels.projectId, project.id))
  .limit(1);
if (!channel) throw new Error("plow-dev channel not provisioned");
console.log("channel:", channel.externalChannelName, channel.externalChannelRef);

const [issue] = await db
  .select()
  .from(issues)
  .where(and(eq(issues.companyId, COMPANY_ID), eq(issues.projectId, project.id)))
  .limit(1);
if (!issue) throw new Error("SAM-2 not found");

// Invite all active agent identities.
const linked = await db
  .select({ externalUserRef: messagingIdentities.externalUserRef })
  .from(messagingIdentities)
  .where(
    and(
      eq(messagingIdentities.companyId, COMPANY_ID),
      eq(messagingIdentities.backend, "slack"),
      eq(messagingIdentities.state, "active"),
    ),
  );
for (const row of linked) {
  try {
    await ctx.adapter.addChannelMember(channel.externalChannelRef, row.externalUserRef);
    console.log("   invited", row.externalUserRef);
  } catch (err) {
    console.log("   already-in-channel or error:", row.externalUserRef, (err as Error).message);
  }
}

console.log("Posting CEO comment...");
const posted = await ctx.router.postMessage({
  companyId: COMPANY_ID,
  issueId: issue.id,
  projectId: project.id,
  authorAgentId: CEO_ID,
  body:
    "Team — we're resetting around Slack-first comms. This issue is our smoke test. " +
    "Reply in this thread to wake me. I'll delegate execution down through eng-mgr / tech-lead / developer once the team's runtime is wired up.",
});
console.log("posted ref id:", posted.id, "ts:", posted.externalMessageRef);
process.exit(0);
