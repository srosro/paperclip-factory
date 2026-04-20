import { and, eq } from "drizzle-orm";
import {
  messagingIdentities,
  messagingWorkspaceInstall,
} from "@paperclipai/db";
import type { Db } from "../../router.js";
import {
  exchangeAppCode,
  storeUserTokenForAgent,
  type LinearAppOAuthEnv,
} from "./oauth-app.js";
import { createLinearClient } from "./client.js";

const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";

const USER_SCOPES = "read,write,comments:create";

export function buildUserAuthorizeUrl(
  env: LinearAppOAuthEnv,
  stateToken: string,
): string {
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", USER_SCOPES);
  url.searchParams.set(
    "redirect_uri",
    `${env.redirectBaseUrl.replace(/\/$/, "")}/api/messaging/linear/oauth/user/callback`,
  );
  url.searchParams.set("state", stateToken);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("actor", "user");
  return url.toString();
}

export interface CompleteUserOAuthArgs {
  db: Db;
  env: LinearAppOAuthEnv;
  code: string;
  companyId: string;
  agentId: string;
  actorUserId: string | null;
}

/** Exchanges code, fetches the Linear user id, persists the identity. */
export async function completeUserOAuth(args: CompleteUserOAuthArgs): Promise<{
  externalUserRef: string;
  secretId: string;
}> {
  void args.actorUserId;
  const redirectUri = `${args.env.redirectBaseUrl.replace(/\/$/, "")}/api/messaging/linear/oauth/user/callback`;
  const exch = await exchangeAppCode({
    env: args.env,
    code: args.code,
    redirectUri,
  });

  const client = createLinearClient({ token: exch.access_token });
  const viewerRes = await client.request<{
    viewer: { id: string; name: string; email?: string };
  }>(`query Viewer { viewer { id name email } }`);
  const linearUserId = viewerRes.viewer.id;

  const [install] = await args.db
    .select()
    .from(messagingWorkspaceInstall)
    .where(
      and(
        eq(messagingWorkspaceInstall.companyId, args.companyId),
        eq(messagingWorkspaceInstall.backend, "linear"),
        eq(messagingWorkspaceInstall.state, "active"),
      ),
    )
    .limit(1);
  const workspaceInstallId = install?.id ?? null;

  const secretId = await storeUserTokenForAgent(
    args.db,
    args.companyId,
    args.agentId,
    exch.access_token,
  );

  const [existing] = await args.db
    .select()
    .from(messagingIdentities)
    .where(
      and(
        eq(messagingIdentities.companyId, args.companyId),
        eq(messagingIdentities.backend, "linear"),
        eq(messagingIdentities.agentId, args.agentId),
      ),
    )
    .limit(1);

  if (existing) {
    await args.db
      .update(messagingIdentities)
      .set({
        externalUserRef: linearUserId,
        workspaceInstallId,
        authBlobSecretId: secretId,
        state: "active",
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(messagingIdentities.id, existing.id));
  } else {
    await args.db.insert(messagingIdentities).values({
      companyId: args.companyId,
      agentId: args.agentId,
      backend: "linear",
      workspaceInstallId,
      externalUserRef: linearUserId,
      authBlobSecretId: secretId,
      state: "active",
      lastRefreshedAt: new Date(),
    });
  }

  return { externalUserRef: linearUserId, secretId };
}
