import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  companySecrets,
  companySecretVersions,
  messagingWorkspaceInstall,
} from "@paperclipai/db";
import { secretService } from "../../../services/secrets.js";
import { localEncryptedProvider } from "../../../secrets/local-encrypted-provider.js";
import type { Db } from "../../router.js";

/**
 * Thin token accessor over the existing company-secrets machinery.
 */
export interface MessagingTokenStore {
  fetchSecretValue(companyId: string, secretId: string): Promise<string>;
}

export function createMessagingTokenStore(db: Db): MessagingTokenStore {
  const secrets = secretService(db);
  return {
    async fetchSecretValue(companyId, secretId) {
      return secrets.resolveSecretValue(companyId, secretId, "latest");
    },
  };
}

// -- company-scoped accessors ------------------------------------------------

/**
 * Resolve the workspace-level bot token for a company install. Requires a
 * `messaging_workspace_install` row for (companyId, slack).
 */
export async function getBotTokenForCompany(
  db: Db,
  companyId: string,
): Promise<string> {
  const [install] = await db
    .select()
    .from(messagingWorkspaceInstall)
    .where(
      and(
        eq(messagingWorkspaceInstall.companyId, companyId),
        eq(messagingWorkspaceInstall.backend, "slack"),
      ),
    )
    .limit(1);
  if (!install) {
    throw new Error(
      `slack token-store: no messaging_workspace_install row for company ${companyId}`,
    );
  }
  const secrets = secretService(db);
  return secrets.resolveSecretValue(companyId, install.botTokenSecretId, "latest");
}

/**
 * Resolve a per-agent user token by its stored secret id.
 */
export async function getUserTokenBySecretId(
  db: Db,
  companyId: string,
  secretId: string,
): Promise<string> {
  const secrets = secretService(db);
  return secrets.resolveSecretValue(companyId, secretId, "latest");
}

/**
 * Resolve the signing secret recorded for a company's install. Callers that
 * can read it from env should prefer env — this path exists for workspaces
 * that overrode the signing secret per-install.
 */
export async function getSigningSecretForCompany(
  db: Db,
  companyId: string,
): Promise<string | null> {
  const [install] = await db
    .select()
    .from(messagingWorkspaceInstall)
    .where(
      and(
        eq(messagingWorkspaceInstall.companyId, companyId),
        eq(messagingWorkspaceInstall.backend, "slack"),
      ),
    )
    .limit(1);
  if (!install) return null;
  const secrets = secretService(db);
  return secrets.resolveSecretValue(companyId, install.signingSecretId, "latest");
}

// -- write helpers -----------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createOrRotateSecret(
  db: Db,
  args: {
    companyId: string;
    name: string;
    value: string;
    description?: string;
    createdByUserId?: string | null;
    createdByAgentId?: string | null;
  },
): Promise<string> {
  const prepared = await localEncryptedProvider.createVersion({
    value: args.value,
    externalRef: null,
  });
  const valueSha256 = sha256Hex(args.value);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, args.companyId),
          eq(companySecrets.name, args.name),
        ),
      )
      .limit(1);

    if (existing) {
      const nextVersion = existing.latestVersion + 1;
      await tx.insert(companySecretVersions).values({
        secretId: existing.id,
        version: nextVersion,
        material: prepared.material,
        valueSha256,
        createdByAgentId: args.createdByAgentId ?? null,
        createdByUserId: args.createdByUserId ?? null,
      });
      await tx
        .update(companySecrets)
        .set({
          latestVersion: nextVersion,
          externalRef: prepared.externalRef,
          description: args.description ?? existing.description,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, existing.id));
      return existing.id;
    }

    const [secret] = await tx
      .insert(companySecrets)
      .values({
        companyId: args.companyId,
        name: args.name,
        provider: "local_encrypted",
        externalRef: prepared.externalRef,
        latestVersion: 1,
        description: args.description ?? null,
        createdByAgentId: args.createdByAgentId ?? null,
        createdByUserId: args.createdByUserId ?? null,
      })
      .returning();

    await tx.insert(companySecretVersions).values({
      secretId: secret!.id,
      version: 1,
      material: prepared.material,
      valueSha256,
      createdByAgentId: args.createdByAgentId ?? null,
      createdByUserId: args.createdByUserId ?? null,
    });
    return secret!.id;
  });
}

/**
 * Store (or rotate) a Slack workspace bot token as a company secret under the
 * conventional name `messaging.slack.bot_token`. Returns the secret id.
 */
export async function storeBotToken(
  db: Db,
  args: {
    companyId: string;
    value: string;
    actorUserId?: string | null;
  },
): Promise<string> {
  return createOrRotateSecret(db, {
    companyId: args.companyId,
    name: "messaging.slack.bot_token",
    value: args.value,
    description: "Slack workspace bot token (OAuth)",
    createdByUserId: args.actorUserId ?? null,
  });
}

/**
 * Store (or rotate) a Slack signing secret as a company secret. Used when a
 * workspace rotates its signing secret and we want to keep the source of
 * truth per-company instead of env.
 */
export async function storeSigningSecret(
  db: Db,
  args: {
    companyId: string;
    value: string;
    actorUserId?: string | null;
  },
): Promise<string> {
  return createOrRotateSecret(db, {
    companyId: args.companyId,
    name: "messaging.slack.signing_secret",
    value: args.value,
    description: "Slack workspace signing secret",
    createdByUserId: args.actorUserId ?? null,
  });
}

/**
 * Store (or rotate) an agent-scoped Slack user token. Secret name is
 * `messaging.slack.user_token.<agentId>`. Returns the secret id.
 */
export async function storeUserToken(
  db: Db,
  args: {
    companyId: string;
    agentId: string;
    value: string;
    actorUserId?: string | null;
  },
): Promise<string> {
  return createOrRotateSecret(db, {
    companyId: args.companyId,
    name: `messaging.slack.user_token.${args.agentId}`,
    value: args.value,
    description: `Slack user token for agent ${args.agentId}`,
    createdByUserId: args.actorUserId ?? null,
    createdByAgentId: args.agentId,
  });
}
