import { describe, expect, it, vi } from "vitest";
import { createLinearAdapter } from "../messaging/adapters/linear/adapter.js";

function stubClient(responses: Array<unknown>) {
  let i = -1;
  return {
    request: vi.fn(async () => {
      i += 1;
      const r = responses[i];
      if (r instanceof Error) throw r;
      return r;
    }),
  };
}

describe("LinearAdapter issue operations", () => {
  it("createIssue resolves the returned Linear issue into an IssueRef", async () => {
    const client = stubClient([
      {
        issueCreate: {
          success: true,
          issue: {
            id: "issue_uuid_1",
            identifier: "SAI-1",
            title: "Bootstrap",
            description: "hi",
            priority: 3,
            state: { id: "s_todo", name: "Todo", type: "unstarted" },
            assignee: null,
            labels: { nodes: [] },
            project: null,
            team: { id: "team_uuid_1", key: "SAI" },
            createdAt: "2026-04-19T12:00:00Z",
            updatedAt: "2026-04-19T12:00:00Z",
          },
        },
      },
    ]);
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app_token",
      getUserToken: async () => "user_token",
      clientFactory: () => client as never,
    });
    const ref = await adapter.createIssue({
      externalTeamRef: "team_uuid_1",
      title: "Bootstrap",
      description: "hi",
      priority: 3,
      author: {
        backend: "linear",
        externalUserRef: "u_1",
        credential: { kind: "user_token", secretId: "s1" },
      },
    });
    expect(ref.externalIssueRef).toBe("issue_uuid_1");
    expect(ref.identifier).toBe("SAI-1");
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("updateIssue posts an issueUpdate mutation", async () => {
    const client = stubClient([
      {
        issueUpdate: {
          success: true,
          issue: {
            id: "issue_uuid_2",
            identifier: "SAI-2",
            title: "new title",
            description: null,
            priority: 2,
            state: { id: "s_inprog", name: "In Progress", type: "started" },
            assignee: { id: "u_1", name: "X", email: null },
            labels: { nodes: [] },
            project: null,
            team: { id: "team_uuid_1", key: "SAI" },
            createdAt: "2026-04-19T12:00:00Z",
            updatedAt: "2026-04-19T12:01:00Z",
          },
        },
      },
    ]);
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app_token",
      getUserToken: async () => "user_token",
      clientFactory: () => client as never,
    });
    const ref = await adapter.updateIssue({
      externalIssueRef: "issue_uuid_2",
      title: "new title",
      priority: 2,
      author: {
        backend: "linear",
        externalUserRef: "u_1",
        credential: { kind: "user_token", secretId: "s1" },
      },
    });
    expect(ref.identifier).toBe("SAI-2");
  });

  it("getIssue returns null for a missing issue", async () => {
    const client = stubClient([{ issue: null }]);
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app_token",
      getUserToken: async () => "user_token",
      clientFactory: () => client as never,
    });
    const result = await adapter.getIssue("nonexistent");
    expect(result).toBeNull();
  });

  it("archiveIssue calls issueArchive", async () => {
    const client = stubClient([{ issueArchive: { success: true } }]);
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app_token",
      getUserToken: async () => "user_token",
      clientFactory: () => client as never,
    });
    await adapter.archiveIssue("issue_uuid_1");
    expect(client.request).toHaveBeenCalledOnce();
  });
});
