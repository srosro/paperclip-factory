import { and, eq } from "drizzle-orm";
import {
  messagingCompanyConfig,
  messagingWorkspaceInstall,
} from "@paperclipai/db";

type MessagingWorkspaceInstallRow = typeof messagingWorkspaceInstall.$inferSelect;
import type { Db, IssueTrackerRouter } from "./router.js";
import { createIssueTrackerRouter } from "./router.js";
import type { EventsProcessor } from "./events.js";
import { createEventsProcessor } from "./events.js";
import type { BackendKey, IssueTrackerAdapter, MessagingEvent } from "./types.js";
import { MessagingNotConfigured } from "./types.js";
import type { StorageService } from "../storage/types.js";
import { createFakeAdapter } from "./adapters/fake/adapter.js";
import { createLinearAdapter } from "./adapters/linear/adapter.js";
import { syncFromLinearEvent } from "./adapters/linear/cache-sync.js";
import type { WorkflowStateMap } from "./adapters/linear/workflow-state-map.js";
import { resolveLinearMentions } from "./adapters/linear/mention-parser.js";
import { selfOriginationTracker } from "./adapters/linear/self-origination.js";

export interface OnMessageCreated {
  (args: {
    refId: string;
    companyId: string;
    issueId: string;
    authorAgentId: string | null;
    authorUserId: string | null;
    authorExternalRef: string;
    mentionedAgentIds: string[];
  }): Promise<void>;
}

export interface LinearResolvers {
  getWorkspaceToken: (companyId: string) => Promise<string>;
  getUserToken: (companyId: string, secretId: string) => Promise<string>;
}

export interface MessagingBootstrapDeps {
  db: Db;
  storage?: StorageService;
  issueUrlBase?: string;
  onMessageCreated?: OnMessageCreated;
  /**
   * Linear resolvers — wired when LINEAR_APP_CLIENT_ID / _SECRET are set in
   * the environment. Undefined otherwise (company resolves to not_installed
   * for backend=linear).
   */
  linear?: LinearResolvers;
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
  adapter: IssueTrackerAdapter;
  router: IssueTrackerRouter;
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
let sharedFakeAdapter: IssueTrackerAdapter | null = null;

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
  if (cfg?.activeBackend === "fake") {
    backend = "fake";
  } else if (cfg?.activeBackend === "linear") {
    backend = "linear";
  } else if (deps.testFallbackBackend === "fake") {
    backend = "fake";
  }

  if (!backend) return { status: "disabled", companyId };

  if (backend === "linear") {
    const [install] = await deps.db
      .select()
      .from(messagingWorkspaceInstall)
      .where(
        and(
          eq(messagingWorkspaceInstall.companyId, companyId),
          eq(messagingWorkspaceInstall.backend, "linear"),
          eq(messagingWorkspaceInstall.state, "active"),
        ),
      )
      .limit(1);
    if (!install || !deps.linear) {
      return { status: "not_installed", companyId, backend };
    }
    const ctx = buildLinearContext(deps, companyId, install);
    contextCache.set(companyId, ctx);
    return ctx;
  }

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
  const router = createIssueTrackerRouter({
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

function buildLinearContext(
  bootstrap: MessagingBootstrapDeps,
  companyId: string,
  install: MessagingWorkspaceInstallRow,
): ReadyMessagingContext {
  if (!bootstrap.linear) throw new Error("Linear resolvers not configured");
  const adapter = createLinearAdapter({
    getWorkspaceToken: bootstrap.linear.getWorkspaceToken,
    getUserToken: bootstrap.linear.getUserToken,
    companyId,
  });
  const router = createIssueTrackerRouter({
    db: bootstrap.db,
    adapter,
    backend: "linear",
    workspaceInstallId: install.id,
    issueUrlBase: bootstrap.issueUrlBase,
  });
  const events = createEventsProcessor({
    db: bootstrap.db,
    backend: "linear",
    workspaceInstallId: install.id,
    onMessageCreated: bootstrap.onMessageCreated,
    resolveMentions: (body) => resolveLinearMentions(bootstrap.db, companyId, body),
    syncFromEvent: (event) => {
      const rawMap = (install.metadata as Record<string, unknown> | null)
        ?.linearWorkflowStateMap as WorkflowStateMap | null | undefined;
      return syncFromLinearEvent(
        { db: bootstrap.db, companyId, workflowStateMap: rawMap ?? null },
        event,
      );
    },
    isSelfOriginated: (event: MessagingEvent) => {
      const ref =
        "externalCommentRef" in event && event.externalCommentRef
          ? event.externalCommentRef
          : "externalIssueRef" in event && event.externalIssueRef
            ? event.externalIssueRef
            : null;
      return ref ? selfOriginationTracker.wasRecentlyMarked(ref) : false;
    },
  });
  return {
    status: "ready",
    companyId,
    backend: "linear",
    adapter,
    router,
    events,
    workspaceInstall: install,
  };
}
