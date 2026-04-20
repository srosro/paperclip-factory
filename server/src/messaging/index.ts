import type { IssueTrackerRouter, Db } from "./router.js";
import type { EventsProcessor } from "./events.js";
import type { StorageService } from "../storage/types.js";
import {
  getLinearWorkspaceTokenForCompany,
  getLinearUserTokenBySecretId,
} from "./adapters/linear/oauth-app.js";

export { messagingRegistry } from "./registry.js";
export type { IssueTrackerRouter, EventsProcessor };
export * from "./types.js";

/**
 * Default Linear OAuth resolvers — wired in app.ts when LINEAR_APP_CLIENT_ID
 * + LINEAR_APP_CLIENT_SECRET are present in the environment.
 */
export function defaultLinearResolvers(db: Db, _storage?: StorageService) {
  return {
    getWorkspaceToken: (companyId: string) =>
      getLinearWorkspaceTokenForCompany(db, companyId),
    getUserToken: (companyId: string, secretId: string) =>
      getLinearUserTokenBySecretId(db, companyId, secretId),
  };
}
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
