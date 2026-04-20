import type { MessagingRouter } from "./router.js";
import type { EventsProcessor } from "./events.js";

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
  getMessagingBootstrapDeps,
  type MessagingBootstrapDeps,
  type MessagingContext,
  type ReadyMessagingContext,
  type OnMessageCreated,
} from "./context.js";
