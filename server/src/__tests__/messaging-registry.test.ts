import { describe, it, expect } from "vitest";
import { createMessagingRegistry } from "../messaging/registry.js";
import type { IssueTrackerAdapter, BackendKey } from "../messaging/types.js";

function stubAdapter(key: BackendKey): IssueTrackerAdapter {
  return { backendKey: key } as unknown as IssueTrackerAdapter;
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
    expect(() => registry.require("linear")).toThrow(/no messaging adapter/i);
  });

  it("get returns undefined for unknown backend", () => {
    const registry = createMessagingRegistry();
    expect(registry.get("linear")).toBeUndefined();
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
    registry.register(stubAdapter("linear"));
    expect(registry.list()).toHaveLength(2);
  });
});
