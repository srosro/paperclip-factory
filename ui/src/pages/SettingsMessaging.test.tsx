// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsMessaging } from "./SettingsMessaging";

const getStatusMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/messaging", () => ({
  messagingApi: {
    getStatus: (companyId: string) => getStatusMock(companyId),
    linearInstallUrl: (companyId: string) =>
      `/api/messaging/linear/oauth/app/start?companyId=${companyId}`,
    linearLinkAgentUrl: (agentId: string) =>
      `/api/messaging/linear/oauth/user/start?agentId=${agentId}`,
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

  it("shows the Connect button and greys out dependent panes when Linear is not installed", async () => {
    getStatusMock.mockResolvedValue({
      installed: false,
      readiness: "disabled",
      activeBackend: null,
      workspaceName: null,
      workspaceRef: null,
      workspaceInstallId: null,
      agentIdentities: [],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = await renderPage(container, queryClient);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Connect Linear workspace");
    expect(container.textContent).toContain("Agent Identities");
    expect(container.textContent).toContain(
      "Connect a Linear workspace to link agent identities.",
    );

    const connectButton = container.querySelector(
      '[data-testid="messaging-connect-workspace"]',
    ) as HTMLButtonElement | null;
    expect(connectButton).not.toBeNull();

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(assignMock).toHaveBeenCalledWith(
      "/api/messaging/linear/oauth/app/start?companyId=company-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders agent identity states and per-agent link buttons when Linear is connected", async () => {
    getStatusMock.mockResolvedValue({
      installed: true,
      readiness: "agent_identities_incomplete",
      activeBackend: "linear",
      workspaceName: "Paperclip HQ",
      workspaceRef: "org_1",
      workspaceInstallId: "install_1",
      agentIdentities: [
        { agentId: "agent-1", agentName: "alpha", state: "active" },
        { agentId: "agent-2", agentName: "bravo", state: "pending_auth" },
      ],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = await renderPage(container, queryClient);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Connected to Paperclip HQ");
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("bravo");

    const linkButton = container.querySelector(
      '[data-testid="messaging-agent-link-agent-2"]',
    ) as HTMLButtonElement | null;
    expect(linkButton).not.toBeNull();
    expect(
      container.querySelector('[data-testid="messaging-agent-link-agent-1"]'),
    ).toBeNull();

    await act(async () => {
      linkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(assignMock).toHaveBeenCalledWith(
      "/api/messaging/linear/oauth/user/start?agentId=agent-2",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("surfaces missing workflow states when readiness=workflow_mapping_incomplete", async () => {
    getStatusMock.mockResolvedValue({
      installed: true,
      readiness: "workflow_mapping_incomplete",
      activeBackend: "linear",
      workspaceName: "Paperclip HQ",
      workspaceRef: "org_1",
      workspaceInstallId: "install_1",
      agentIdentities: [],
      missingWorkflowStates: ["in_review", "blocked"],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = await renderPage(container, queryClient);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Team workflow is missing");
    expect(container.textContent).toContain("in_review, blocked");

    await act(async () => {
      root.unmount();
    });
  });
});
