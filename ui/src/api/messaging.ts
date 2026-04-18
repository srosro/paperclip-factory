import { api } from "./client";

export type MessagingIdentityState = "active" | "pending_auth" | "revoked";

export interface MessagingAgentIdentity {
  agentId: string;
  agentName: string;
  state: MessagingIdentityState;
}

export interface MessagingStatus {
  installed: boolean;
  workspaceName: string | null;
  workspaceRef: string | null;
  agentIdentities: MessagingAgentIdentity[];
}

export interface InboxPreferences {
  assignment: boolean;
  mention: boolean;
  approval_requested: boolean;
  status_change: boolean;
  watching: boolean;
}

export const messagingApi = {
  getStatus: (companyId: string) =>
    api.get<MessagingStatus>(
      `/companies/${encodeURIComponent(companyId)}/messaging/status`,
    ),
  getInboxPrefs: (companyId: string) =>
    api
      .get<{ prefs: InboxPreferences }>(
        `/messaging/inbox-prefs?companyId=${encodeURIComponent(companyId)}`,
      )
      .then((r) => r.prefs),
  updateInboxPrefs: (companyId: string, prefs: Partial<InboxPreferences>) =>
    api
      .patch<{ prefs: InboxPreferences }>(`/messaging/inbox-prefs`, {
        companyId,
        prefs,
      })
      .then((r) => r.prefs),
  botOauthStartUrl: (companyId: string) =>
    `/api/messaging/slack/oauth/bot/start?companyId=${encodeURIComponent(companyId)}`,
  userOauthStartUrl: (agentId: string) =>
    `/api/messaging/slack/oauth/user/start?agentId=${encodeURIComponent(agentId)}`,
};
