// One-shot smoke test helper used during the Paperclip Factory bring-up on
// 2026-04-18. Invites all linked agents to a given issue's ad-hoc channel,
// then posts a comment as the named agent. Hardcoded IDs for Sam's Plow
// Peeps — keep as a reference pattern, not a general tool.
// Usage: pnpm --filter @paperclipai/server exec tsx scripts/slack-smoke.ts
import { and, eq } from "drizzle-orm";
import {
  createDb,
  messagingChannels,
  messagingIdentities,
  messagingThreads,
} from "@paperclipai/db";
import {
  defaultSlackResolvers,
  initMessaging,
  requireMessagingContext,
} from "../src/messaging/index.js";

const COMPANY_ID = "9ec08c8f-e0df-4a6c-a1ec-db3b93615665";
const ISSUE_ID = "0f2b1766-b80f-4cb7-b3b2-72cd454e4f77"; // SAM-1
const CEO_ID = "9f6e9a34-6876-433f-bdb9-1a5ce24a44fe";

const conn = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const db = createDb(conn);

initMessaging({ db, slack: defaultSlackResolvers(db) });

const ctx = await requireMessagingContext(COMPANY_ID);
console.log("backend:", ctx.backend);
console.log(
  "workspace:",
  ctx.workspaceInstall?.externalWorkspaceRef,
  ctx.workspaceInstall?.workspaceName,
);

// Look up SAM-1's thread + channel.
const [thread] = await db
  .select()
  .from(messagingThreads)
  .where(eq(messagingThreads.issueId, ISSUE_ID))
  .limit(1);
if (!thread) {
  console.error("no thread for SAM-1 yet — did the first post run?");
  process.exit(1);
}
const [channel] = await db
  .select()
  .from(messagingChannels)
  .where(eq(messagingChannels.id, thread.channelId))
  .limit(1);
console.log("channel:", channel!.externalChannelRef, channel!.externalChannelName);

// Invite every linked agent's Slack user to the channel so their user tokens
// can post. Bot must be in-channel (it created it, so it is). Safe to re-run:
// conversations.invite is a no-op for already-present users (and Slack errors
// "already_in_channel" on re-invite which we swallow).
const identities = await db
  .select()
  .from(messagingIdentities)
  .where(
    and(
      eq(messagingIdentities.companyId, COMPANY_ID),
      eq(messagingIdentities.backend, "slack"),
      eq(messagingIdentities.state, "active"),
    ),
  );
for (const id of identities) {
  try {
    await ctx.adapter.addChannelMember(channel!.externalChannelRef, id.externalUserRef);
    console.log("invited", id.externalUserRef);
  } catch (err) {
    console.log("invite-or-already-in-channel for", id.externalUserRef, (err as Error).message);
  }
}

const posted = await ctx.router.postMessage({
  companyId: COMPANY_ID,
  issueId: ISSUE_ID,
  projectId: null,
  authorAgentId: CEO_ID,
  body: "Smoke test from CEO - if you see this in Slack, outbound Paperclip -> Slack posting works.",
});

console.log("posted:", JSON.stringify(posted, null, 2));
process.exit(0);
