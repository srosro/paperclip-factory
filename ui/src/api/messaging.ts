import { api } from "./client";

export type MessagingIdentityState = "active" | "pending_auth" | "revoked";

export interface MessagingAgentIdentity {
  agentId: string;
  agentName: string;
  state: MessagingIdentityState;
}

export type MessagingReadiness =
  | "disabled"
  | "not_installed"
  | "agent_identities_incomplete"
  | "ready";

export interface MessagingStatus {
  installed: boolean;
  readiness: MessagingReadiness;
  activeBackend: string | null;
  workspaceName: string | null;
  workspaceRef: string | null;
  workspaceInstallId: string | null;
  agentIdentities: MessagingAgentIdentity[];
}

export const messagingApi = {
  getStatus: (companyId: string) =>
    api.get<MessagingStatus>(
      `/companies/${encodeURIComponent(companyId)}/messaging/status`,
    ),
};
