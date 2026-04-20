import { describe, expect, it } from "vitest";
import {
  extractLinearMentions,
  normalizeLinearEvent,
} from "../messaging/adapters/linear/events-normalize.js";

const base = {
  webhookId: "wh_1",
  webhookTimestamp: 1700000000000,
  organizationId: "org_1",
  createdAt: "2026-04-19T12:00:00Z",
};

describe("normalizeLinearEvent", () => {
  it("Comment.create → comment_created", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "create",
      type: "Comment",
      data: {
        id: "c_1",
        body: "hi @[Alice](mention-u_alice) ping",
        createdAt: "2026-04-19T12:00:00Z",
        issue: { id: "issue_1", identifier: "SAI-1" },
        user: { id: "u_1", name: "X" },
      },
    });
    expect(event?.kind).toBe("comment_created");
    if (event?.kind !== "comment_created") return;
    expect(event.externalIssueRef).toBe("issue_1");
    expect(event.externalCommentRef).toBe("c_1");
    expect(event.authorExternalRef).toBe("u_1");
    expect(event.bodyRaw).toBe("hi @[Alice](mention-u_alice) ping");
    expect(event.mentionedExternalRefs).toEqual(["u_alice"]);
  });

  it("Comment.update → comment_updated", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "update",
      type: "Comment",
      data: {
        id: "c_1",
        body: "edited",
        createdAt: "2026-04-19T12:00:00Z",
        editedAt: "2026-04-19T12:05:00Z",
        issue: { id: "issue_1" },
      },
    });
    expect(event?.kind).toBe("comment_updated");
  });

  it("Comment.remove → comment_deleted", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "remove",
      type: "Comment",
      data: { id: "c_1", body: "x", createdAt: "2026-04-19T12:00:00Z", issue: { id: "issue_1" } },
    });
    expect(event?.kind).toBe("comment_deleted");
  });

  it("Issue.update with assignee change → issue_assignee_changed", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "update",
      type: "Issue",
      data: {
        id: "issue_1",
        identifier: "SAI-1",
        assignee: { id: "u_new", name: "Y" },
      },
      updatedFrom: { assigneeId: "u_old" },
    });
    expect(event?.kind).toBe("issue_assignee_changed");
    if (event?.kind !== "issue_assignee_changed") return;
    expect(event.newAssigneeExternalRef).toBe("u_new");
  });

  it("Issue.update without assignee change → issue_updated", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "update",
      type: "Issue",
      data: {
        id: "issue_1",
        identifier: "SAI-1",
        state: { id: "s_1" },
      },
      updatedFrom: { stateId: "s_0" },
    });
    expect(event?.kind).toBe("issue_updated");
    if (event?.kind !== "issue_updated") return;
    expect(event.changedFields).toEqual(["stateId"]);
  });

  it("Issue.create → issue_created", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "create",
      type: "Issue",
      data: { id: "issue_1", identifier: "SAI-1", assignee: { id: "u_1" } },
    });
    expect(event?.kind).toBe("issue_created");
  });

  it("IssueLabel.create → labels_changed (added)", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "create",
      type: "IssueLabel",
      data: { issueId: "issue_1", labelId: "L_1" },
    });
    expect(event?.kind).toBe("labels_changed");
    if (event?.kind !== "labels_changed") return;
    expect(event.addedExternalLabelRefs).toEqual(["L_1"]);
  });

  it("Reaction.create → reaction_added", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "create",
      type: "Reaction",
      data: {
        id: "r_1",
        emoji: "+1",
        comment: { id: "c_1", issue: { id: "issue_1" } },
        user: { id: "u_1" },
      },
    });
    expect(event?.kind).toBe("reaction_added");
  });

  it("returns null for unsupported event type", () => {
    const event = normalizeLinearEvent({
      ...base,
      action: "create",
      type: "Cycle",
      data: { id: "cycle_1" },
    } as never);
    expect(event).toBeNull();
  });
});

describe("extractLinearMentions", () => {
  it("parses one mention", () => {
    expect(extractLinearMentions("hey @[Alice](mention-u_a) !")).toEqual(["u_a"]);
  });
  it("parses multiple mentions", () => {
    expect(
      extractLinearMentions("@[A](mention-u_a) and @[B](mention-u_b)"),
    ).toEqual(["u_a", "u_b"]);
  });
  it("returns empty for no mentions", () => {
    expect(extractLinearMentions("no mentions here")).toEqual([]);
  });
});
