import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Slack, CheckCircle2, AlertCircle } from "lucide-react";
import { messagingApi, type InboxPreferences, type MessagingAgentIdentity } from "@/api/messaging";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleField } from "@/components/agent-config-primitives";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

const PREF_LABELS: Array<{ key: keyof InboxPreferences; label: string; hint: string }> = [
  {
    key: "assignment",
    label: "Assignments",
    hint: "DM me when an issue is assigned to me.",
  },
  {
    key: "mention",
    label: "Mentions",
    hint: "DM me when someone @-mentions me in a thread.",
  },
  {
    key: "approval_requested",
    label: "Approvals",
    hint: "DM me when an approval is requested from me.",
  },
  {
    key: "status_change",
    label: "Status changes",
    hint: "DM me when an issue I own changes status.",
  },
];

function stateBadge(state: MessagingAgentIdentity["state"]) {
  if (state === "active") {
    return (
      <Badge
        variant="outline"
        className="border-green-600/40 bg-green-600/10 text-green-700 dark:text-green-500"
      >
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Linked
      </Badge>
    );
  }
  if (state === "revoked") {
    return (
      <Badge variant="destructive" className="bg-destructive/15 text-destructive">
        <AlertCircle className="mr-1 h-3 w-3" />
        Revoked
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    >
      Not linked
    </Badge>
  );
}

export function SettingsMessaging() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Messaging" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const statusQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.messaging.status(selectedCompanyId)
      : (["messaging", "status", "__disabled__"] as const),
    queryFn: () => messagingApi.getStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const prefsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.messaging.inboxPrefs(selectedCompanyId)
      : (["messaging", "inbox-prefs", "__disabled__"] as const),
    queryFn: () => messagingApi.getInboxPrefs(selectedCompanyId!),
    enabled: !!selectedCompanyId && statusQuery.data?.installed === true,
  });

  const prefsMutation = useMutation({
    mutationFn: (next: Partial<InboxPreferences>) =>
      messagingApi.updateInboxPrefs(selectedCompanyId!, next),
    onSuccess: (prefs) => {
      queryClient.setQueryData(
        queryKeys.messaging.inboxPrefs(selectedCompanyId!),
        prefs,
      );
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update preference",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!selectedCompany || !selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  const status = statusQuery.data;
  const installed = status?.installed ?? false;
  const readiness = status?.readiness ?? "disabled";
  const prefs = prefsQuery.data;

  function handleConnectWorkspace() {
    window.location.assign(messagingApi.botOauthStartUrl(selectedCompanyId!));
  }

  function handleLinkAgent(agentId: string) {
    window.location.assign(messagingApi.userOauthStartUrl(agentId));
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Messaging</h1>
      </div>

      {/* Workspace pane */}
      <div className="space-y-4" data-testid="messaging-workspace-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Slack Workspace
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          {statusQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading status...</p>
          ) : statusQuery.isError ? (
            <p className="text-sm text-destructive">
              {statusQuery.error instanceof Error
                ? statusQuery.error.message
                : "Failed to load messaging status"}
            </p>
          ) : installed ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Slack className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">
                    Connected to {status?.workspaceName ?? "Slack workspace"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {readiness === "agent_identities_incomplete"
                      ? "Workspace connected, but one or more agents still need to link their Slack identity."
                      : readiness === "ready"
                      ? "Paperclip will post issue threads and inbox DMs in this workspace."
                      : "Paperclip will post issue threads and inbox DMs in this workspace."}
                  </div>
                </div>
              </div>
              {stateBadge(readiness === "ready" ? "active" : "pending_auth")}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {readiness === "disabled"
                  ? "Messaging is disabled for this company. Connect a Slack workspace to enable it."
                  : "Connect a Slack workspace to route issue threads and per-user inbox DMs through Slack."}
              </p>
              <Button
                size="sm"
                onClick={handleConnectWorkspace}
                data-testid="messaging-connect-workspace"
              >
                <Slack className="mr-1.5 h-3.5 w-3.5" />
                Connect Slack workspace
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Agent identities pane */}
      <div
        className={`space-y-4 ${!installed ? "pointer-events-none opacity-50" : ""}`}
        data-testid="messaging-agents-section"
      >
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Agent Identities
        </div>
        <div className="rounded-md border border-border">
          {!installed ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              Connect a Slack workspace to link agent identities.
            </p>
          ) : statusQuery.isLoading ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">Loading agents...</p>
          ) : (status?.agentIdentities ?? []).length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              No agents in this company yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {(status?.agentIdentities ?? []).map((agent) => (
                <div
                  key={agent.agentId}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                  data-testid={`messaging-agent-row-${agent.agentId}`}
                >
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">{agent.agentName}</div>
                    {stateBadge(agent.state)}
                  </div>
                  {agent.state === "active" ? null : (
                    <Button
                      size="sm"
                      variant={agent.state === "revoked" ? "destructive" : "outline"}
                      onClick={() => handleLinkAgent(agent.agentId)}
                      data-testid={`messaging-agent-link-${agent.agentId}`}
                    >
                      {agent.state === "revoked" ? "Re-link" : "Link"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Inbox prefs pane */}
      <div
        className={`space-y-4 ${!installed ? "pointer-events-none opacity-50" : ""}`}
        data-testid="messaging-inbox-section"
      >
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          My Inbox
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          {!installed ? (
            <p className="text-sm text-muted-foreground">
              Connect a Slack workspace to receive direct-message inbox notifications.
            </p>
          ) : prefsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading preferences...</p>
          ) : prefsQuery.isError ? (
            <p className="text-sm text-destructive">
              {prefsQuery.error instanceof Error
                ? prefsQuery.error.message
                : "Failed to load inbox preferences"}
            </p>
          ) : prefs ? (
            PREF_LABELS.map(({ key, label, hint }) => (
              <ToggleField
                key={key}
                label={label}
                hint={hint}
                checked={!!prefs[key]}
                onChange={(v) => prefsMutation.mutate({ [key]: v } as Partial<InboxPreferences>)}
                toggleTestId={`messaging-inbox-toggle-${key}`}
              />
            ))
          ) : null}
        </div>
      </div>
    </div>
  );
}
