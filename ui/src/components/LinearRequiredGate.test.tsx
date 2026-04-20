// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LinearRequiredGate } from "./LinearRequiredGate";

const getStatusMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/messaging", () => ({
  messagingApi: { getStatus: (id: string) => getStatusMock(id) },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("LinearRequiredGate", () => {
  let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); });
  afterEach(() => { container.remove(); vi.clearAllMocks(); });

  it("shows children when readiness=ready", async () => {
    getStatusMock.mockResolvedValue({ readiness: "ready" });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider><LinearRequiredGate><span>my content</span></LinearRequiredGate></TooltipProvider>
        </QueryClientProvider>
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(container.textContent).toContain("my content");
    await act(async () => { root.unmount(); });
  });

  it("shows setup prompt when readiness=disabled", async () => {
    getStatusMock.mockResolvedValue({ readiness: "disabled" });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider><LinearRequiredGate><span>my content</span></LinearRequiredGate></TooltipProvider>
        </QueryClientProvider>
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(container.textContent).not.toContain("my content");
    expect(container.textContent).toContain("Connect a Linear workspace");
    await act(async () => { root.unmount(); });
  });

  it("shows children when status query errors (fail-open)", async () => {
    getStatusMock.mockRejectedValue(new Error("network error"));
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TooltipProvider><LinearRequiredGate><span>my content</span></LinearRequiredGate></TooltipProvider>
        </QueryClientProvider>
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(container.textContent).toContain("my content");
    await act(async () => { root.unmount(); });
  });
});
