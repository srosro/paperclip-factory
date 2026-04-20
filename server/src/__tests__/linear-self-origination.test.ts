import { describe, expect, it } from "vitest";
import { SelfOriginationTracker } from "../messaging/adapters/linear/self-origination.js";

describe("self-origination tracker", () => {
  it("returns true for a recently-marked ref", () => {
    const t = new SelfOriginationTracker({ ttlMs: 1000 });
    t.mark("comment_1");
    expect(t.wasRecentlyMarked("comment_1")).toBe(true);
  });

  it("returns false after TTL expires", async () => {
    const t = new SelfOriginationTracker({ ttlMs: 10 });
    t.mark("comment_2");
    await new Promise((r) => setTimeout(r, 30));
    expect(t.wasRecentlyMarked("comment_2")).toBe(false);
  });

  it("returns false for unknown refs", () => {
    const t = new SelfOriginationTracker();
    expect(t.wasRecentlyMarked("never")).toBe(false);
  });

  it("respects maxSize by evicting oldest entries first", () => {
    const t = new SelfOriginationTracker({ maxSize: 2, ttlMs: 10000 });
    t.mark("a");
    t.mark("b");
    t.mark("c");
    expect(t.wasRecentlyMarked("a")).toBe(false);
    expect(t.wasRecentlyMarked("b")).toBe(true);
    expect(t.wasRecentlyMarked("c")).toBe(true);
  });
});
