import { describe, it, expect } from "vitest";
import { createFakeAdapter } from "../messaging/adapters/fake/adapter.js";
import type { MessagingEvent } from "../messaging/types.js";

describe("FakeAdapter", () => {
  it("creates a channel and returns a unique external ref", async () => {
    const adapter = createFakeAdapter();
    const a = await adapter.createChannel({ name: "proj-a", purpose: "project" });
    const b = await adapter.createChannel({ name: "proj-b", purpose: "project" });
    expect(a.externalRef).not.toBe(b.externalRef);
  });

  it("posts a message and echoes it as a synchronous inbound event", async () => {
    const adapter = createFakeAdapter();
    const ch = await adapter.createChannel({ name: "proj-x", purpose: "project" });
    const th = await adapter.createThread({
      channelRef: ch.externalRef,
      parentBlocks: null,
      fallbackText: "issue card",
    });

    const echoed: MessagingEvent[] = [];
    adapter.onLocalEvent((e) => echoed.push(e));

    await adapter.postMessage({
      channelRef: ch.externalRef,
      threadRef: th.threadRef,
      authorIdentity: { backend: "fake", externalUserRef: "U_A", credential: { kind: "none" } },
      body: "hello",
    });

    expect(echoed).toHaveLength(1);
    expect(echoed[0]).toMatchObject({
      kind: "message",
      bodyRaw: "hello",
      authorExternalRef: "U_A",
    });
  });

  it("getThreadMessages returns posted messages in order", async () => {
    const adapter = createFakeAdapter();
    const ch = await adapter.createChannel({ name: "proj-y", purpose: "project" });
    const th = await adapter.createThread({
      channelRef: ch.externalRef,
      parentBlocks: null,
      fallbackText: "card",
    });
    const identity = {
      backend: "fake" as const,
      externalUserRef: "U_A",
      credential: { kind: "none" as const },
    };
    const a = await adapter.postMessage({
      channelRef: ch.externalRef,
      threadRef: th.threadRef,
      authorIdentity: identity,
      body: "first",
    });
    const b = await adapter.postMessage({
      channelRef: ch.externalRef,
      threadRef: th.threadRef,
      authorIdentity: identity,
      body: "second",
    });
    const msgs = await adapter.getThreadMessages(ch.externalRef, th.threadRef);
    expect(msgs.map((m) => m.externalMessageRef)).toEqual([a.messageRef, b.messageRef]);
    expect(msgs.map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("editMessage updates body and emits message_changed event", async () => {
    const adapter = createFakeAdapter();
    const ch = await adapter.createChannel({ name: "proj-z", purpose: "project" });
    const th = await adapter.createThread({
      channelRef: ch.externalRef,
      parentBlocks: null,
      fallbackText: "card",
    });
    const events: MessagingEvent[] = [];
    adapter.onLocalEvent((e) => events.push(e));

    const posted = await adapter.postMessage({
      channelRef: ch.externalRef,
      threadRef: th.threadRef,
      authorIdentity: { backend: "fake", externalUserRef: "U_A", credential: { kind: "none" } },
      body: "v1",
    });
    await adapter.editMessage(ch.externalRef, posted.messageRef, "v2");

    const msgs = await adapter.getThreadMessages(ch.externalRef, th.threadRef);
    expect(msgs[0]!.body).toBe("v2");
    expect(msgs[0]!.editedAt).toBeDefined();
    expect(events.map((e) => e.kind)).toEqual(["message", "message_changed"]);
  });

  it("deleteMessage sets deletedAt and hides from getThreadMessages", async () => {
    const adapter = createFakeAdapter();
    const ch = await adapter.createChannel({ name: "proj-d", purpose: "project" });
    const th = await adapter.createThread({
      channelRef: ch.externalRef,
      parentBlocks: null,
      fallbackText: "card",
    });
    const identity = {
      backend: "fake" as const,
      externalUserRef: "U_A",
      credential: { kind: "none" as const },
    };
    const posted = await adapter.postMessage({
      channelRef: ch.externalRef,
      threadRef: th.threadRef,
      authorIdentity: identity,
      body: "gone",
    });
    await adapter.deleteMessage(ch.externalRef, posted.messageRef, identity);
    const msgs = await adapter.getThreadMessages(ch.externalRef, th.threadRef);
    expect(msgs).toHaveLength(0);
  });

  it("failNextPost injects failure into the next postMessage only", async () => {
    const adapter = createFakeAdapter();
    const ch = await adapter.createChannel({ name: "proj-f", purpose: "project" });
    const th = await adapter.createThread({
      channelRef: ch.externalRef,
      parentBlocks: null,
      fallbackText: "card",
    });
    const args = {
      channelRef: ch.externalRef,
      threadRef: th.threadRef,
      authorIdentity: {
        backend: "fake" as const,
        externalUserRef: "U_A",
        credential: { kind: "none" as const },
      },
      body: "retry me",
    };
    adapter.failNextPost("rate_limited");
    await expect(adapter.postMessage(args)).rejects.toThrow(/rate_limited/);
    await expect(adapter.postMessage(args)).resolves.toBeDefined();
  });
});
