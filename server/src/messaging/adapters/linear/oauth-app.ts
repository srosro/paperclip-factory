import { and, eq } from "drizzle-orm";
import { companySecrets } from "@paperclipai/db";
import type { Db } from "../../router.js";
import { secretService } from "../../../services/secrets.js";

const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";

const APP_SCOPES = "read,write,issues:create,comments:create,app:assignable,app:mentionable";

export interface LinearAppOAuthEnv {
  clientId: string;
  clientSecret: string;
  redirectBaseUrl: string;
}

export function readLinearEnv(): LinearAppOAuthEnv | null {
  const clientId = process.env.LINEAR_APP_CLIENT_ID;
  const clientSecret = process.env.LINEAR_APP_CLIENT_SECRET;
  const redirectBaseUrl =
    process.env.PAPERCLIP_PUBLIC_BASE_URL ??
    process.env.LINEAR_OAUTH_REDIRECT_BASE_URL;
  if (!clientId || !clientSecret || !redirectBaseUrl) return null;
  return { clientId, clientSecret, redirectBaseUrl };
}

export interface AppAuthorizeUrlArgs {
  companyId: string;
  stateToken: string;
}

export function buildAppAuthorizeUrl(
  env: LinearAppOAuthEnv,
  args: AppAuthorizeUrlArgs,
): string {
  void args;
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", APP_SCOPES);
  url.searchParams.set(
    "redirect_uri",
    `${env.redirectBaseUrl.replace(/\/$/, "")}/api/messaging/linear/oauth/app/callback`,
  );
  url.searchParams.set("state", args.stateToken);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("actor", "app");
  return url.toString();
}

export interface ExchangeCodeArgs {
  env: LinearAppOAuthEnv;
  code: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface AppTokenExchangeResult {
  access_token: string;
  token_type: string;
  scope: string;
  organization_id?: string;
  expires_in?: number;
}

export async function exchangeAppCode(
  args: ExchangeCodeArgs,
): Promise<AppTokenExchangeResult> {
  const fetchFn = args.fetch ?? fetch;
  const body = new URLSearchParams({
    client_id: args.env.clientId,
    client_secret: args.env.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
    code: args.code,
  });
  const res = await fetchFn(LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Linear OAuth token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as AppTokenExchangeResult;
}

/**
 * Persist a Linear app/workspace-scoped access token in company_secrets.
 * If a secret with the canonical name already exists, rotates to a new
 * version; otherwise creates it. Returns the secret id.
 */
export async function storeWorkspaceAppToken(
  db: Db,
  companyId: string,
  token: string,
): Promise<string> {
  const svc = secretService(db);
  const existing = await svc.getByName(companyId, "messaging.linear.app_token");
  if (existing) {
    await svc.rotate(existing.id, { value: token });
    return existing.id;
  }
  const created = await svc.create(companyId, {
    name: "messaging.linear.app_token",
    provider: "local_encrypted",
    value: token,
  });
  return created.id;
}

/**
 * Persist a per-agent Linear user-scoped access token. Name is
 * `messaging.linear.user_token.<agentId>`.
 */
export async function storeUserTokenForAgent(
  db: Db,
  companyId: string,
  agentId: string,
  token: string,
): Promise<string> {
  const svc = secretService(db);
  const name = `messaging.linear.user_token.${agentId}`;
  const existing = await svc.getByName(companyId, name);
  if (existing) {
    await svc.rotate(existing.id, { value: token });
    return existing.id;
  }
  const created = await svc.create(companyId, {
    name,
    provider: "local_encrypted",
    value: token,
  });
  return created.id;
}

/** Persist the webhook signing secret for a company. */
export async function storeWebhookSecret(
  db: Db,
  companyId: string,
  secret: string,
): Promise<string> {
  const svc = secretService(db);
  const existing = await svc.getByName(
    companyId,
    "messaging.linear.webhook_secret",
  );
  if (existing) {
    await svc.rotate(existing.id, { value: secret });
    return existing.id;
  }
  const created = await svc.create(companyId, {
    name: "messaging.linear.webhook_secret",
    provider: "local_encrypted",
    value: secret,
  });
  return created.id;
}

export async function getLinearWorkspaceTokenForCompany(
  db: Db,
  companyId: string,
): Promise<string> {
  const svc = secretService(db);
  const secret = await svc.getByName(companyId, "messaging.linear.app_token");
  if (!secret) {
    throw new Error(`No Linear workspace token for company ${companyId}`);
  }
  return svc.resolveSecretValue(companyId, secret.id, "latest");
}

export async function getLinearUserTokenBySecretId(
  db: Db,
  companyId: string,
  secretId: string,
): Promise<string> {
  const svc = secretService(db);
  return svc.resolveSecretValue(companyId, secretId, "latest");
}

/** Look up a webhook signing secret by companyId (used by /events route). */
export async function getWebhookSecretForCompany(
  db: Db,
  companyId: string,
): Promise<string | null> {
  const [secret] = await db
    .select()
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.name, "messaging.linear.webhook_secret"),
      ),
    )
    .limit(1);
  if (!secret) return null;
  const svc = secretService(db);
  return svc.resolveSecretValue(companyId, secret.id, "latest");
}
