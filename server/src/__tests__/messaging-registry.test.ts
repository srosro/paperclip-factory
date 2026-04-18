import { describe, it, expect } from "vitest";
import { createMessagingRegistry } from "../messaging/registry.js";
import type { MessagingAdapter, BackendKey } from "../messaging/types.js";

function stubAdapter(key: BackendKey): MessagingAdapter {
  return { backendKey: key } as unknown as MessagingAdapter;
}

describe("messaging registry", () => {
  it("registers and retrieves an adapter by key", () => {
    const registry = createMessagingRegistry();
    const fake = stubAdapter("fake");
    registry.register(fake);
    expect(registry.get("fake")).toBe(fake);
  });

  it("require throws when retrieving an unknown backend", () => {
    const registry = createMessagingRegistry();
    expect(() => registry.require("slack")).toThrow(/no messaging adapter/i);
  });

  it("get returns undefined for unknown backend", () => {
    const registry = createMessagingRegistry();
    expect(registry.get("slack")).toBeUndefined();
  });

  it("rejects duplicate registration of the same backend", () => {
    const registry = createMessagingRegistry();
    registry.register(stubAdapter("fake"));
    expect(() => registry.register(stubAdapter("fake"))).toThrow(/already registered/i);
  });

  it("unregister removes a registered adapter", () => {
    const registry = createMessagingRegistry();
    registry.register(stubAdapter("fake"));
    registry.unregister("fake");
    expect(registry.get("fake")).toBeUndefined();
  });

  it("list returns all registered adapters", () => {
    const registry = createMessagingRegistry();
    registry.register(stubAdapter("fake"));
    registry.register(stubAdapter("slack"));
    expect(registry.list()).toHaveLength(2);
  });
});
