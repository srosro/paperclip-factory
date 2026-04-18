import type { Db } from "./router.js";
import { messagingRegistry } from "./registry.js";
import { createMessagingRouter, type MessagingRouter } from "./router.js";
import { createEventsProcessor, type EventsProcessor } from "./events.js";
import { createFakeAdapter } from "./adapters/fake/adapter.js";
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
  /** Called after a new inbound message is persisted and not suppressed. */
  onMessageCreated?: (args: {
    refId: string;
    companyId: string;
    issueId: string;
    authorAgentId: string | null;
    authorUserId: string | null;
    mentionedAgentIds: string[];
  }) => Promise<void>;
  resolveMentions?: (rawBody: string) => Promise<string[]>;
  issueUrlBase?: string;
}

export function initMessaging(args: InitMessagingArgs): void {
  currentBackend = args.backend ?? "fake";
  // Register FakeAdapter if not already present (idempotent by swallowing dup-register).
  try {
    messagingRegistry.register(createFakeAdapter());
  } catch {
    // already registered
  }
  router = createMessagingRouter({
    db: args.db,
    registry: messagingRegistry,
    backend: currentBackend,
    issueUrlBase: args.issueUrlBase,
  });
  events = createEventsProcessor({
    db: args.db,
    backend: currentBackend,
    onMessageCreated: args.onMessageCreated,
    resolveMentions: args.resolveMentions,
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
