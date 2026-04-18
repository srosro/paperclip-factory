import { eq } from "drizzle-orm";
import { assets, issueAttachments } from "@paperclipai/db";
import type { Readable } from "node:stream";
import type { Db, MessagingRouter } from "./router.js";
import type { StorageService } from "../storage/types.js";
import type { EventsProcessor } from "./events.js";
import {
  getBotTokenForCompany,
  getUserTokenBySecretId,
} from "./adapters/slack/token-store.js";

export { messagingRegistry } from "./registry.js";
export type { MessagingRouter, EventsProcessor };
export * from "./types.js";
export {
  initMessaging,
  resetMessagingForTests,
  isMessagingInitialized,
  resolveMessagingContext,
  requireMessagingContext,
  invalidateMessagingContext,
  findCompanyIdForSlackTeam,
  getMessagingBootstrapDeps,
  type MessagingBootstrapDeps,
  type MessagingContext,
  type ReadyMessagingContext,
  type SlackTokenResolvers,
  type OnMessageCreated,
} from "./context.js";

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks);
}

async function resolveAttachmentBytes(
  db: Db,
  storage: StorageService,
  companyId: string,
  paperclipAttachmentId: string,
): Promise<Buffer> {
  const rows = await db
    .select({
      companyId: issueAttachments.companyId,
      objectKey: assets.objectKey,
    })
    .from(issueAttachments)
    .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
    .where(eq(issueAttachments.id, paperclipAttachmentId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`attachment ${paperclipAttachmentId} not found`);
  if (row.companyId !== companyId) {
    throw new Error(
      `attachment ${paperclipAttachmentId} company mismatch (expected ${companyId}, got ${row.companyId})`,
    );
  }
  const object = await storage.getObject(row.companyId, row.objectKey);
  return streamToBuffer(object.stream);
}

/**
 * Build the default Slack token resolvers over a Db. The runtime wires this
 * directly in app startup; tests wire their own resolvers. Pass a storage
 * service to enable outbound attachment uploads from Paperclip's blob store.
 */
export function defaultSlackResolvers(db: Db, storage?: StorageService) {
  return {
    getBotToken: (companyId: string) => getBotTokenForCompany(db, companyId),
    getUserToken: (companyId: string, secretId: string) =>
      getUserTokenBySecretId(db, companyId, secretId),
    getAttachmentBytes: storage
      ? (companyId: string, paperclipAttachmentId: string) =>
          resolveAttachmentBytes(db, storage, companyId, paperclipAttachmentId)
      : undefined,
  };
}
