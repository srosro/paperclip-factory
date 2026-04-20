import { describe, expect, it, vi } from "vitest";
import { createLinearAdapter } from "../messaging/adapters/linear/adapter.js";

function stubClient(fn: (query: string, vars: unknown) => Promise<unknown>) {
  return { request: vi.fn(fn) };
}

describe("LinearAdapter comment operations", () => {
  it("postComment creates a comment via the author's token", async () => {
    const client = stubClient(async (q, vars) => {
      expect(q).toContain("commentCreate");
      expect(
        (vars as { input: { issueId: string; body: string } }).input.issueId,
      ).toBe("issue_1");
      return {
        commentCreate: {
          success: true,
          comment: {
            id: "comment_1",
            body: "hi",
            createdAt: "2026-04-19T12:00:00Z",
            updatedAt: "2026-04-19T12:00:00Z",
            editedAt: null,
            user: { id: "u_1", name: "Agent" },
            issue: { id: "issue_1", identifier: "SAI-1" },
          },
        },
      };
    });
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app",
      getUserToken: async () => "user_token",
      clientFactory: () => client as never,
    });
    const ref = await adapter.postComment({
      externalIssueRef: "issue_1",
      author: {
        backend: "linear",
        externalUserRef: "u_1",
        credential: { kind: "user_token", secretId: "s" },
      },
      body: "hi",
    });
    expect(ref.externalCommentRef).toBe("comment_1");
  });

  it("getComments returns normalized Comment[] sorted by createdAt", async () => {
    const client = stubClient(async () => ({
      issue: {
        comments: {
          nodes: [
            {
              id: "c_2",
              body: "second",
              createdAt: "2026-04-19T12:01:00Z",
              updatedAt: "2026-04-19T12:01:00Z",
              editedAt: null,
              user: { id: "u_1", name: "X" },
              issue: { id: "issue_1", identifier: "SAI-1" },
            },
            {
              id: "c_1",
              body: "first",
              createdAt: "2026-04-19T12:00:00Z",
              updatedAt: "2026-04-19T12:00:00Z",
              editedAt: null,
              user: { id: "u_1", name: "X" },
              issue: { id: "issue_1", identifier: "SAI-1" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app",
      getUserToken: async () => "user",
      clientFactory: () => client as never,
    });
    const comments = await adapter.getComments("issue_1");
    expect(comments.map((c) => c.externalCommentRef)).toEqual(["c_1", "c_2"]);
  });

  it("editComment invokes commentUpdate", async () => {
    const client = stubClient(async (q, vars) => {
      expect(q).toContain("commentUpdate");
      expect((vars as { id: string; input: { body: string } }).id).toBe(
        "comment_1",
      );
      expect((vars as { id: string; input: { body: string } }).input.body).toBe(
        "updated",
      );
      return { commentUpdate: { success: true } };
    });
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app",
      getUserToken: async () => "user",
      clientFactory: () => client as never,
    });
    await adapter.editComment("comment_1", "updated");
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("deleteComment invokes commentDelete with the author's token", async () => {
    const client = stubClient(async (q) => {
      expect(q).toContain("commentDelete");
      return { commentDelete: { success: true } };
    });
    const adapter = createLinearAdapter({
      companyId: "co1",
      getWorkspaceToken: async () => "app",
      getUserToken: async () => "user_token",
      clientFactory: () => client as never,
    });
    await adapter.deleteComment("comment_1", {
      backend: "linear",
      externalUserRef: "u_1",
      credential: { kind: "user_token", secretId: "s" },
    });
    expect(client.request).toHaveBeenCalledOnce();
  });
});
