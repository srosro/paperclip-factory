import { describe, it, expect } from "vitest";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import type { MessagingEvent } from "../messaging/types.js";

const AUTHOR = {
  backend: "fake" as const,
  externalUserRef: "U_A",
  credential: { kind: "none" as const },
};

describe("FakeAdapter", () => {
  it("creates an issue and emits a synchronous issue_created event", async () => {
    const adapter = createFakeAdapter();
    const events: MessagingEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));
    const issue = await adapter.createIssue({
      externalTeamRef: "T_1",
      title: "First",
      author: AUTHOR,
    });
    expect(issue.externalIssueRef).toBeTruthy();
    expect(issue.identifier).toMatch(/^FAKE-\d+$/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "issue_created",
      externalIssueRef: issue.externalIssueRef,
    });
  });

  it("updateIssue emits issue_updated with changed fields", async () => {
    const adapter = createFakeAdapter();
    const issue = await adapter.createIssue({
      externalTeamRef: "T_1",
      title: "x",
      author: AUTHOR,
    });
    const events: MessagingEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));
    await adapter.updateIssue({
      externalIssueRef: issue.externalIssueRef,
      title: "y",
      author: AUTHOR,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "issue_updated",
      changedFields: ["title"],
    });
  });

  it("postComment emits comment_created and is returned by getComments", async () => {
    const adapter = createFakeAdapter();
    const issue = await adapter.createIssue({
      externalTeamRef: "T_1",
      title: "x",
      author: AUTHOR,
    });
    const events: MessagingEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));

    const c1 = await adapter.postComment({
      externalIssueRef: issue.externalIssueRef,
      author: AUTHOR,
      body: "first",
    });
    const c2 = await adapter.postComment({
      externalIssueRef: issue.externalIssueRef,
      author: AUTHOR,
      body: "second",
    });

    expect(events.map((e) => e.kind)).toEqual(["comment_created", "comment_created"]);
    const comments = await adapter.getComments(issue.externalIssueRef);
    expect(comments.map((c) => c.externalCommentRef)).toEqual([
      c1.externalCommentRef,
      c2.externalCommentRef,
    ]);
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("editComment mutates body and emits comment_updated", async () => {
    const adapter = createFakeAdapter();
    const issue = await adapter.createIssue({
      externalTeamRef: "T_1",
      title: "x",
      author: AUTHOR,
    });
    const posted = await adapter.postComment({
      externalIssueRef: issue.externalIssueRef,
      author: AUTHOR,
      body: "v1",
    });
    const events: MessagingEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));
    await adapter.editComment(posted.externalCommentRef, "v2");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "comment_updated", bodyRaw: "v2" });
    const comments = await adapter.getComments(issue.externalIssueRef);
    expect(comments[0]!.body).toBe("v2");
  });

  it("deleteComment sets deletedAt and emits comment_deleted", async () => {
    const adapter = createFakeAdapter();
    const issue = await adapter.createIssue({
      externalTeamRef: "T_1",
      title: "x",
      author: AUTHOR,
    });
    const posted = await adapter.postComment({
      externalIssueRef: issue.externalIssueRef,
      author: AUTHOR,
      body: "gone",
    });
    const events: MessagingEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));
    await adapter.deleteComment(posted.externalCommentRef, AUTHOR);
    expect(events[0]).toMatchObject({ kind: "comment_deleted" });
  });

  it("ensureLabel is idempotent per name", async () => {
    const adapter = createFakeAdapter();
    const a = await adapter.ensureLabel("company-x", "bug");
    const b = await adapter.ensureLabel("company-x", "bug");
    const c = await adapter.ensureLabel("company-x", "feature");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("setIssueLabels tracks added/removed labels and emits labels_changed", async () => {
    const adapter = createFakeAdapter();
    const issue = await adapter.createIssue({
      externalTeamRef: "T_1",
      title: "x",
      author: AUTHOR,
    });
    const bugLabel = await adapter.ensureLabel("c", "bug");
    const events: MessagingEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));
    await adapter.setIssueLabels(issue.externalIssueRef, [bugLabel]);
    expect(events[0]).toMatchObject({
      kind: "labels_changed",
      addedExternalLabelRefs: [bugLabel],
      removedExternalLabelRefs: [],
    });
  });
});
