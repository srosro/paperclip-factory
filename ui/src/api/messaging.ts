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
  | "workflow_mapping_incomplete"
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
  missingWorkflowStates?: string[];
}

export const messagingApi = {
  getStatus: (companyId: string) =>
    api.get<MessagingStatus>(
      `/companies/${encodeURIComponent(companyId)}/messaging/status`,
    ),
  linearInstallUrl: (companyId: string) =>
    `/api/messaging/linear/oauth/app/start?companyId=${encodeURIComponent(companyId)}`,
  linearLinkAgentUrl: (agentId: string) =>
    `/api/messaging/linear/oauth/user/start?agentId=${encodeURIComponent(agentId)}`,
};
