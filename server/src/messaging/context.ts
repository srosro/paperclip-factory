import { and, eq } from "drizzle-orm";
import {
  messagingCompanyConfig,
  messagingWorkspaceInstall,
} from "@paperclipai/db";

type MessagingWorkspaceInstallRow = typeof messagingWorkspaceInstall.$inferSelect;
import type { Db, MessagingRouter } from "./router.js";
import { createMessagingRouter } from "./router.js";
import type { EventsProcessor } from "./events.js";
import { createEventsProcessor } from "./events.js";
import type { BackendKey, MessagingAdapter } from "./types.js";
import { MessagingNotConfigured } from "./types.js";
import type { StorageService } from "../storage/types.js";
import { createFakeAdapter } from "./adapters/fake/adapter.js";
import { createSlackAdapter } from "./adapters/slack/adapter.js";
import { resolveSlackMentions, rewriteOutboundBodyForSlack } from "./adapters/slack/mention-parser.js";
import { createSlackFileIngest } from "./adapters/slack/file-ingest.js";

export interface SlackTokenResolvers {
  getBotToken: (companyId: string) => Promise<string>;
  getUserToken: (companyId: string, secretId: string) => Promise<string>;
  getAttachmentBytes?: (
    companyId: string,
    paperclipAttachmentId: string,
  ) => Promise<Buffer>;
}

export interface OnMessageCreated {
  (args: {
    refId: string;
    companyId: string;
    issueId: string;
    authorAgentId: string | null;
    authorUserId: string | null;
    authorExternalRef: string;
    mentionedAgentIds: string[];
    mentionedUserIds: string[];
  }): Promise<void>;
}

export interface MessagingBootstrapDeps {
  db: Db;
  storage?: StorageService;
  issueUrlBase?: string;
  onMessageCreated?: OnMessageCreated;
  slack?: SlackTokenResolvers;
  /**
   * Test-only fallback. When set, companies without a messaging_company_config
   * row are treated as if activeBackend = testFallbackBackend. Production
   * deployments leave this undefined so missing config surfaces as
   * MessagingNotConfigured.
   */
  testFallbackBackend?: BackendKey;
}

export interface ReadyMessagingContext {
  status: "ready";
  companyId: string;
  backend: BackendKey;
  adapter: MessagingAdapter;
  router: MessagingRouter;
  events: EventsProcessor;
  workspaceInstall?: MessagingWorkspaceInstallRow;
}

export type MessagingContext =
  | { status: "disabled"; companyId: string }
  | { status: "not_installed"; companyId: string; backend: BackendKey }
  | ReadyMessagingContext;

let deps: MessagingBootstrapDeps | null = null;
const contextCache = new Map<string, ReadyMessagingContext>();
// A single shared FakeAdapter across all test companies — matches the old
// global semantics (tests seed messages into the fake adapter, then read back
// through any company's router). Built lazily on first fake resolution.
let sharedFakeAdapter: MessagingAdapter | null = null;

export function initMessaging(bootstrap: MessagingBootstrapDeps): void {
  deps = bootstrap;
  contextCache.clear();
  sharedFakeAdapter = null;
}

export function resetMessagingForTests(): void {
  deps = null;
  contextCache.clear();
  sharedFakeAdapter = null;
}

export function isMessagingInitialized(): boolean {
  return deps !== null;
}

export function getMessagingBootstrapDeps(): MessagingBootstrapDeps {
  if (!deps) {
    throw new Error("messaging not initialized — call initMessaging()");
  }
  return deps;
}

/**
 * Internal helper so inbound Slack webhook routes can look up the company
 * from an incoming team_id before resolving a context.
 */
export async function findCompanyIdForSlackTeam(
  team: string,
): Promise<string | null> {
  if (!deps) return null;
  const [install] = await deps.db
    .select({ companyId: messagingWorkspaceInstall.companyId })
    .from(messagingWorkspaceInstall)
    .where(
      and(
        eq(messagingWorkspaceInstall.backend, "slack"),
        eq(messagingWorkspaceInstall.externalWorkspaceRef, team),
      ),
    )
    .limit(1);
  return install?.companyId ?? null;
}

export async function resolveMessagingContext(
  companyId: string,
): Promise<MessagingContext> {
  if (!deps) {
    throw new Error("messaging not initialized — call initMessaging()");
  }
  const cached = contextCache.get(companyId);
  if (cached) return cached;

  const [cfg] = await deps.db
    .select()
    .from(messagingCompanyConfig)
    .where(eq(messagingCompanyConfig.companyId, companyId))
    .limit(1);

  let backend: BackendKey | null = null;
  if (cfg?.activeBackend === "slack" || cfg?.activeBackend === "fake") {
    backend = cfg.activeBackend;
  } else if (deps.testFallbackBackend) {
    backend = deps.testFallbackBackend;
  }

  if (!backend) return { status: "disabled", companyId };

  if (backend === "slack") {
    const [install] = await deps.db
      .select()
      .from(messagingWorkspaceInstall)
      .where(
        and(
          eq(messagingWorkspaceInstall.companyId, companyId),
          eq(messagingWorkspaceInstall.backend, "slack"),
          eq(messagingWorkspaceInstall.state, "active"),
        ),
      )
      .limit(1);
    if (!install || !deps.slack) {
      return { status: "not_installed", companyId, backend };
    }
    const ctx = buildSlackContext(deps, companyId, install);
    contextCache.set(companyId, ctx);
    return ctx;
  }

  // backend === 'fake'
  const ctx = buildFakeContext(deps, companyId);
  contextCache.set(companyId, ctx);
  return ctx;
}

export async function requireMessagingContext(
  companyId: string,
): Promise<ReadyMessagingContext> {
  const ctx = await resolveMessagingContext(companyId);
  if (ctx.status !== "ready") {
    throw new MessagingNotConfigured(companyId);
  }
  return ctx;
}

/**
 * Clear a company's cached context so the next resolve rereads config. Called
 * after install/uninstall events and after test resets.
 */
export function invalidateMessagingContext(companyId: string): void {
  contextCache.delete(companyId);
}

function buildFakeContext(
  bootstrap: MessagingBootstrapDeps,
  companyId: string,
): ReadyMessagingContext {
  if (!sharedFakeAdapter) {
    sharedFakeAdapter = createFakeAdapter();
  }
  const adapter = sharedFakeAdapter;
  const router = createMessagingRouter({
    db: bootstrap.db,
    adapter,
    backend: "fake",
    issueUrlBase: bootstrap.issueUrlBase,
  });
  const events = createEventsProcessor({
    db: bootstrap.db,
    backend: "fake",
    onMessageCreated: bootstrap.onMessageCreated,
  });
  // Wire FakeAdapter echo → events processor for this company's router.
  if (
    "onLocalEvent" in adapter &&
    typeof (adapter as { onLocalEvent?: unknown }).onLocalEvent === "function"
  ) {
    (adapter as unknown as { onLocalEvent: (cb: (e: unknown) => void) => void }).onLocalEvent(
      (e: unknown) => {
        void events.handle(e as Parameters<EventsProcessor["handle"]>[0]);
      },
    );
  }
  return {
    status: "ready",
    companyId,
    backend: "fake",
    adapter,
    router,
    events,
  };
}

function buildSlackContext(
  bootstrap: MessagingBootstrapDeps,
  companyId: string,
  install: MessagingWorkspaceInstallRow,
): ReadyMessagingContext {
  if (!bootstrap.slack) {
    throw new Error("slack resolvers not configured");
  }
  const adapter = createSlackAdapter({
    getBotToken: bootstrap.slack.getBotToken,
    getUserToken: bootstrap.slack.getUserToken,
    companyId,
    rewriteOutboundBody: (cid, body) =>
      rewriteOutboundBodyForSlack(bootstrap.db, cid, body),
    getAttachmentBytes: bootstrap.slack.getAttachmentBytes,
  });
  const router = createMessagingRouter({
    db: bootstrap.db,
    adapter,
    backend: "slack",
    issueUrlBase: bootstrap.issueUrlBase,
  });
  const ingestInboundFiles = bootstrap.storage
    ? createSlackFileIngest({ db: bootstrap.db, storage: bootstrap.storage })
    : undefined;
  const events = createEventsProcessor({
    db: bootstrap.db,
    backend: "slack",
    onMessageCreated: bootstrap.onMessageCreated,
    resolveMentions: (body) => resolveSlackMentions(bootstrap.db, body),
    ingestInboundFiles,
  });
  return {
    status: "ready",
    companyId,
    backend: "slack",
    adapter,
    router,
    events,
    workspaceInstall: install,
  };
}
