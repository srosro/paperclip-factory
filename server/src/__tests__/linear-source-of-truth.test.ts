import { describe, expect, it } from "vitest";
import { normalizeLinearEvent } from "../messaging/adapters/linear/events-normalize.js";

describe("normalizeLinearEvent — issue_updated full snapshot", () => {
  it("carries title, description, and priority from the webhook payload", () => {
    const raw = {
      webhookId: "wh1",
      webhookTimestamp: 1000,
      type: "Issue",
      action: "update",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedFrom: { stateId: "old-state" },
      data: {
        id: "LIN-1",
        identifier: "PLO-1",
        title: "Updated title",
        description: "Updated desc",
        priority: 2,
        assignee: null,
        state: { id: "state-in-progress" },
      },
    };
    const event = normalizeLinearEvent(raw);
    expect(event?.kind).toBe("issue_updated");
    if (event?.kind !== "issue_updated") throw new Error("wrong kind");
    expect(event.title).toBe("Updated title");
    expect(event.description).toBe("Updated desc");
    expect(event.priority).toBe(2);
    expect(event.stateExternalRef).toBe("state-in-progress");
  });
});
