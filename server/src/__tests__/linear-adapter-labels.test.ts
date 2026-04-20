import { describe, expect, it, vi } from "vitest";
import { createLinearAdapter } from "../messaging/adapters/linear/adapter.js";

describe("LinearAdapter label operations", () => {
  it("ensureLabel creates a label when it doesn't exist", async () => {
    const calls: Array<{ q: string; vars: unknown }> = [];
    const client = {
      request: vi.fn(async (q: string, vars: unknown) => {
        calls.push({ q, vars });
        if (q.includes("TeamLabels")) {
          return { team: { labels: { nodes: [] } } };
        }
        return {
          issueLabelCreate: {
            success: true,
            issueLabel: { id: "L_new", name: "bug", color: "#f00" },
          },
        };
      }),
    };
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app",
      getUserToken: async () => "user",
      clientFactory: () => client as never,
    });
    const ref = await adapter.ensureLabel("co1", "bug", "#f00", "team_1");
    expect(ref).toBe("L_new");
    expect(calls).toHaveLength(2);
  });

  it("ensureLabel returns the existing label UUID when it already exists", async () => {
    const client = {
      request: vi.fn(async () => ({
        team: {
          labels: {
            nodes: [
              { id: "L_existing", name: "bug", color: "#f00" },
            ],
          },
        },
      })),
    };
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app",
      getUserToken: async () => "user",
      clientFactory: () => client as never,
    });
    const ref = await adapter.ensureLabel("co1", "bug", "#f00", "team_1");
    expect(ref).toBe("L_existing");
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("setIssueLabels calls issueUpdate with labelIds", async () => {
    const client = {
      request: vi.fn(async () => ({
        issueUpdate: {
          success: true,
          issue: {
            id: "i1",
            identifier: "SAI-1",
            title: "x",
            description: null,
            priority: 0,
            state: null,
            assignee: null,
            labels: { nodes: [] },
            project: null,
            team: { id: "t1", key: "SAI" },
            createdAt: "2026-04-19T12:00:00Z",
            updatedAt: "2026-04-19T12:00:00Z",
          },
        },
      })),
    };
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app",
      getUserToken: async () => "user",
      clientFactory: () => client as never,
    });
    await adapter.setIssueLabels("i1", ["L_1", "L_2"]);
    expect(client.request).toHaveBeenCalledOnce();
  });
});
