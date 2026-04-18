import { describe, it, expect } from "vitest";
import { createSlackAdapter } from "../messaging/adapters/slack/adapter.js";

describe("slack adapter capabilities", () => {
  const adapter = createSlackAdapter({
    async getBotToken() {
      return "xoxb-test";
    },
    async getUserToken() {
      return "xoxp-test";
    },
  });

  it("declares backend key 'slack'", () => {
    expect(adapter.backendKey).toBe("slack");
  });

  it("declares the expected capability flags", () => {
    expect(adapter.capabilities).toMatchObject({
      supportsThreads: true,
      supportsEditing: true,
      supportsReactions: true,
      supportsButtons: true,
      supportsFileUpload: true,
      supportsThreadLock: false,
      requiresUserAuthPerIdentity: true,
    });
  });
});
