import { eq } from "drizzle-orm";
import {
  assets,
  issueAttachments,
  messagingWorkspaceInstall,
} from "@paperclipai/db";
import type { Readable } from "node:stream";
import type { Db } from "./router.js";
import type { StorageService } from "../storage/types.js";
import { messagingRegistry } from "./registry.js";
import { createMessagingRouter, type MessagingRouter } from "./router.js";
import { createEventsProcessor, type EventsProcessor } from "./events.js";
import { createFakeAdapter } from "./adapters/fake/adapter.js";
import { createSlackAdapter } from "./adapters/slack/adapter.js";
import { resolveSlackMentions } from "./adapters/slack/mention-parser.js";
import { rewriteOutboundBodyForSlack } from "./adapters/slack/mention-parser.js";
import {
  getBotTokenForCompany,
  getUserTokenBySecretId,
} from "./adapters/slack/token-store.js";
import { createSlackFileIngest } from "./adapters/slack/file-ingest.js";
import type { BackendKey } from "./types.js";

export { messagingRegistry };
export type { MessagingRouter, EventsProcessor };
export * from "./types.js";

let initialized = false;
let router: MessagingRouter | null = null;
let events: EventsProcessor | null = null;
let currentBackend: BackendKey = "fake";

export interface InitMessagingArgs {
  db: Db;
  backend?: BackendKey;
  /**
   * Storage service for asset/attachment round-trip. Required when slack is
   * configured and inbound file ingestion / outbound attachment upload are
   * desired. When omitted, messaging still functions — attachments are no-op.
   */
  storage?: StorageService;
  /** Called after a new inbound message is persisted and not suppressed. */
  onMessageCreated?: (args: {
    refId: string;
    companyId: string;
    issueId: string;
    authorAgentId: string | null;
    authorUserId: string | null;
    authorExternalRef: string;
    mentionedAgentIds: string[];
    mentionedUserIds: string[];
  }) => Promise<void>;
  resolveMentions?: (
    rawBody: string,
  ) => Promise<{ agentIds: string[]; userIds: string[] }>;
  issueUrlBase?: string;
  /**
   * Slack adapter token resolvers. When provided, a SlackAdapter is
   * registered alongside the FakeAdapter so the Slack webhook + router can
   * use it. Per-company token lookups are routed through these.
   */
  slack?: {
    getBotToken: (companyId: string) => Promise<string>;
    getUserToken: (companyId: string, secretId: string) => Promise<string>;
    /**
     * Resolve raw bytes for a Paperclip attachment. Used by the Slack adapter
     * when postMessage carries inline attachments. Optional; if omitted, the
     * adapter throws when asked to upload.
     */
    getAttachmentBytes?: (
      companyId: string,
      paperclipAttachmentId: string,
    ) => Promise<Buffer>;
  };
}

export async function initMessaging(args: InitMessagingArgs): Promise<void> {
  currentBackend = args.backend ?? "fake";
  // Register FakeAdapter if not already present (idempotent by swallowing dup-register).
  try {
    messagingRegistry.register(createFakeAdapter());
  } catch {
    // already registered
  }

  // Register SlackAdapter when Slack env is configured. Phase 1 pins the
  // adapter to the single workspace install if exactly one exists; Phase 2
  // will switch to per-request scoping.
  if (args.slack) {
    try {
      messagingRegistry.unregister("slack");
    } catch {
      // no-op
    }
    let pinnedCompanyId: string | undefined;
    try {
      const installs = await args.db
        .select({ companyId: messagingWorkspaceInstall.companyId })
        .from(messagingWorkspaceInstall)
        .where(eq(messagingWorkspaceInstall.backend, "slack"))
        .limit(2);
      if (installs.length === 1) {
        pinnedCompanyId = installs[0]!.companyId;
      }
    } catch {
      // Table may not exist in extremely old dev DBs — leave unpinned.
    }

    const slackAdapter = createSlackAdapter({
      getBotToken: args.slack.getBotToken,
      getUserToken: args.slack.getUserToken,
      companyId: pinnedCompanyId,
      rewriteOutboundBody: (cid, body) =>
        rewriteOutboundBodyForSlack(args.db, cid, body),
      getAttachmentBytes: args.slack.getAttachmentBytes,
    });
    messagingRegistry.register(slackAdapter);
  }

  router = createMessagingRouter({
    db: args.db,
    registry: messagingRegistry,
    backend: currentBackend,
    issueUrlBase: args.issueUrlBase,
  });

  const resolveMentions =
    args.resolveMentions ??
    (currentBackend === "slack"
      ? (body: string) => resolveSlackMentions(args.db, body)
      : undefined);

  const ingestInboundFiles =
    currentBackend === "slack" && args.storage
      ? createSlackFileIngest({ db: args.db, storage: args.storage })
      : undefined;

  events = createEventsProcessor({
    db: args.db,
    backend: currentBackend,
    onMessageCreated: args.onMessageCreated,
    resolveMentions,
    ingestInboundFiles,
  });

  // Wire adapter echo → events processor (for FakeAdapter in local/dev).
  const adapter = messagingRegistry.get(currentBackend);
  if (
    adapter &&
    "onLocalEvent" in adapter &&
    typeof (adapter as { onLocalEvent?: unknown }).onLocalEvent === "function"
  ) {
    (adapter as unknown as { onLocalEvent: (cb: (e: unknown) => void) => void }).onLocalEvent(
      (e: unknown) => {
        if (events) void events.handle(e as Parameters<EventsProcessor["handle"]>[0]);
      },
    );
  }

  initialized = true;
}

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

export function resetMessagingForTests(): void {
  router = null;
  events = null;
  initialized = false;
}

export function getMessagingRouter(): MessagingRouter {
  if (!router) throw new Error("messaging not initialized — call initMessaging()");
  return router;
}

export function getEventsProcessor(): EventsProcessor {
  if (!events) throw new Error("messaging events not initialized — call initMessaging()");
  return events;
}

export function isMessagingInitialized(): boolean {
  return initialized;
}
