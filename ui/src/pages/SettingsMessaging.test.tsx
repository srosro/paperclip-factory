// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsMessaging } from "./SettingsMessaging";

const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

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

async function renderPage(container: HTMLElement) {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <SettingsMessaging />
      </TooltipProvider>,
    );
  });
  return root;
}

describe("SettingsMessaging", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the disabled coming-soon panel for Plan A", async () => {
    const root = await renderPage(container);
    expect(container.textContent).toContain("Messaging is currently disabled");
    expect(container.textContent).toContain("Linear integration");
    const button = container.querySelector(
      '[data-testid="messaging-connect-linear"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  it("sets breadcrumbs on mount", async () => {
    const root = await renderPage(container);
    expect(setBreadcrumbsMock).toHaveBeenCalledWith([
      { label: "Paperclip", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Messaging" },
    ]);
    await act(async () => {
      root.unmount();
    });
  });
});
