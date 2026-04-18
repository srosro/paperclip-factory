// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsMessaging } from "./SettingsMessaging";

const getStatusMock = vi.hoisted(() => vi.fn());
const getInboxPrefsMock = vi.hoisted(() => vi.fn());
const updateInboxPrefsMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/messaging", () => ({
  messagingApi: {
    getStatus: (companyId: string) => getStatusMock(companyId),
    getInboxPrefs: (companyId: string) => getInboxPrefsMock(companyId),
    updateInboxPrefs: (companyId: string, prefs: unknown) =>
      updateInboxPrefsMock(companyId, prefs),
    botOauthStartUrl: (companyId: string) =>
      `/api/messaging/slack/oauth/bot/start?companyId=${companyId}`,
    userOauthStartUrl: (agentId: string) =>
      `/api/messaging/slack/oauth/user/start?agentId=${agentId}`,
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderPage(container: HTMLElement, queryClient: QueryClient) {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SettingsMessaging />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("SettingsMessaging", () => {
  let container: HTMLDivElement;
  let assignMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    assignMock = vi.fn();
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignMock, origin: "http://localhost" },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("shows the Connect button and greys out dependent panes when Slack is not installed", async () => {
    getStatusMock.mockResolvedValue({
      installed: false,
      workspaceName: null,
      workspaceRef: null,
      agentIdentities: [],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = await renderPage(container, queryClient);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Connect Slack workspace");
    expect(container.textContent).toContain("Agent Identities");
    expect(container.textContent).toContain(
      "Connect a Slack workspace to link agent identities.",
    );
    expect(container.textContent).toContain(
      "Connect a Slack workspace to receive direct-message inbox notifications.",
    );
    expect(getInboxPrefsMock).not.toHaveBeenCalled();

    const connectButton = container.querySelector(
      '[data-testid="messaging-connect-workspace"]',
    ) as HTMLButtonElement | null;
    expect(connectButton).not.toBeNull();

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(assignMock).toHaveBeenCalledWith(
      "/api/messaging/slack/oauth/bot/start?companyId=company-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders agent identity states and inbox prefs when Slack is connected", async () => {
    getStatusMock.mockResolvedValue({
      installed: true,
      workspaceName: "Paperclip HQ",
      workspaceRef: "T_WS1",
      agentIdentities: [
        { agentId: "agent-1", agentName: "alpha", state: "active" },
        { agentId: "agent-2", agentName: "bravo", state: "pending_auth" },
      ],
    });
    getInboxPrefsMock.mockResolvedValue({
      assignment: true,
      mention: true,
      approval_requested: true,
      status_change: true,
      watching: false,
    });
    updateInboxPrefsMock.mockResolvedValue({
      assignment: false,
      mention: true,
      approval_requested: true,
      status_change: true,
      watching: false,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = await renderPage(container, queryClient);
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Connected to Paperclip HQ");
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("bravo");

    const linkButton = container.querySelector(
      '[data-testid="messaging-agent-link-agent-2"]',
    ) as HTMLButtonElement | null;
    expect(linkButton).not.toBeNull();
    // Active agent has no link button.
    expect(
      container.querySelector('[data-testid="messaging-agent-link-agent-1"]'),
    ).toBeNull();

    await act(async () => {
      linkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(assignMock).toHaveBeenCalledWith(
      "/api/messaging/slack/oauth/user/start?agentId=agent-2",
    );

    const assignmentToggle = container.querySelector(
      '[data-testid="messaging-inbox-toggle-assignment"]',
    ) as HTMLButtonElement | null;
    expect(assignmentToggle).not.toBeNull();

    await act(async () => {
      assignmentToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(updateInboxPrefsMock).toHaveBeenCalledWith("company-1", {
      assignment: false,
    });

    await act(async () => {
      root.unmount();
    });
  });
});
