import { describe, expect, it } from "vitest";
import type { IssueTrackerAdapter } from "../messaging/types.js";

describe("IssueTrackerAdapter interface", () => {
  it("is exported from messaging/types with the issue-centric method surface", () => {
    // Compile-time only: this test fails to compile if any of the expected
    // methods disappear from the interface.
    const stub = {} as IssueTrackerAdapter;
    void (stub.createIssue as unknown);
    void (stub.postComment as unknown);
    void (stub.getComments as unknown);
    void (stub.normalizeEvent as unknown);
    expect(true).toBe(true);
  });
});
