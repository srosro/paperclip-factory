import { describe, it, expect } from "vitest";
import { normalizeSlackEvent } from "../messaging/adapters/slack/adapter.js";

describe("normalizeSlackEvent", () => {
  it("normalizes a top-level channel message", () => {
    const event = normalizeSlackEvent({
      event_id: "Ev1",
      event: {
        type: "message",
        channel: "C1",
        ts: "1700000000.000001",
        user: "U1",
        text: "hello",
      },
    });
    expect(event).toMatchObject({
      kind: "message",
      externalEventId: "Ev1",
      channelRef: "C1",
      messageRef: "1700000000.000001",
      authorExternalRef: "U1",
      bodyRaw: "hello",
    });
    expect(event?.kind === "message" && event.threadRef).toBeUndefined();
  });

  it("normalizes a thread reply with thread_ts", () => {
    const event = normalizeSlackEvent({
      event_id: "Ev2",
      event: {
        type: "message",
        channel: "C1",
        ts: "1700000010.000100",
        thread_ts: "1700000000.000001",
        user: "U2",
        text: "reply",
      },
    });
    expect(event?.kind).toBe("message");
    expect(event?.kind === "message" && event.threadRef).toBe("1700000000.000001");
  });

  it("normalizes message_changed (edit)", () => {
    const event = normalizeSlackEvent({
      event_id: "Ev3",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: {
          type: "message",
          ts: "1700000000.000001",
          user: "U1",
          text: "edited",
          edited: { ts: "1700000020.000000" },
        },
      },
    });
    expect(event).toMatchObject({
      kind: "message_changed",
      externalEventId: "Ev3",
      messageRef: "1700000000.000001",
      channelRef: "C1",
      bodyRaw: "edited",
    });
  });

  it("normalizes message_deleted", () => {
    const event = normalizeSlackEvent({
      event_id: "Ev4",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "1700000000.000001",
        event_ts: "1700000030.000000",
      },
    });
    expect(event).toMatchObject({
      kind: "message_deleted",
      externalEventId: "Ev4",
      messageRef: "1700000000.000001",
      channelRef: "C1",
    });
  });

  it("normalizes reaction_added", () => {
    const event = normalizeSlackEvent({
      event_id: "Ev5",
      event: {
        type: "reaction_added",
        user: "U2",
        reaction: "+1",
        item: { ts: "1700000000.000001", channel: "C1" },
        event_ts: "1700000040.000000",
      },
    });
    expect(event).toMatchObject({
      kind: "reaction_added",
      externalEventId: "Ev5",
      messageRef: "1700000000.000001",
      channelRef: "C1",
      reactorExternalRef: "U2",
      emoji: "+1",
    });
  });

  it("returns null for irrelevant event types", () => {
    expect(
      normalizeSlackEvent({
        event_id: "Ev6",
        event: { type: "team_join" },
      }),
    ).toBeNull();
  });

  it("returns null for channel_join subtype messages", () => {
    expect(
      normalizeSlackEvent({
        event_id: "Ev7",
        event: {
          type: "message",
          subtype: "channel_join",
          channel: "C1",
          user: "U1",
          ts: "1700000000.000001",
        },
      }),
    ).toBeNull();
  });
});
