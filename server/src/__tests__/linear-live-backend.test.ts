import { describe, expect, it } from "vitest";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";

describe("IssueTrackerAdapter — list/search/getByIdentifier", () => {
  it("listIssues returns issues filtered by assignee", async () => {
    const adapter = createFakeAdapter();
    const { externalIssueRef: ref1 } = await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Alpha",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Beta",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    const all = await adapter.listIssues({ externalTeamRef: "team1" });
    expect(all.length).toBe(2);

    await adapter.updateIssue({
      externalIssueRef: ref1,
      assigneeExternalRef: "u1",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    const assigned = await adapter.listIssues({
      externalTeamRef: "team1",
      assigneeExternalRef: "u1",
    });
    expect(assigned.length).toBe(1);
    expect(assigned[0]!.externalIssueRef).toBe(ref1);
  });

  it("searchIssues returns issues matching query", async () => {
    const adapter = createFakeAdapter();
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Fix the login bug",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "Add dashboard chart",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    const results = await adapter.searchIssues({ externalTeamRef: "team1", query: "login" });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain("login");
  });

  it("getIssueByIdentifier returns the matching issue", async () => {
    const adapter = createFakeAdapter();
    await adapter.createIssue({
      externalTeamRef: "team1",
      title: "My Issue",
      author: { externalUserRef: "u1", credential: { kind: "none" } },
    });
    const issue = await adapter.getIssueByIdentifier("FAKE-1");
    expect(issue).not.toBeNull();
    expect(issue!.title).toBe("My Issue");

    const miss = await adapter.getIssueByIdentifier("FAKE-999");
    expect(miss).toBeNull();
  });
});
