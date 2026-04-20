import { describe, expect, it } from "vitest";
import type {
  IssueTrackerAdapter,
  MessagingAdapter,
} from "../messaging/types.js";

describe("IssueTrackerAdapter interface", () => {
  it("is exported from messaging/types and is structurally compatible with MessagingAdapter", () => {
    // Compile-time: if IssueTrackerAdapter doesn't exist or isn't assignable
    // from MessagingAdapter, this file fails to typecheck.
    type AssertAssignable = MessagingAdapter extends IssueTrackerAdapter
      ? true
      : false;
    const ok: AssertAssignable = true;
    expect(ok).toBe(true);
  });
});
