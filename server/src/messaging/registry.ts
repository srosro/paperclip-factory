import type { BackendKey, IssueTrackerAdapter } from "./types.js";

export interface MessagingRegistry {
  register(adapter: IssueTrackerAdapter): void;
  unregister(key: BackendKey): void;
  get(key: BackendKey): IssueTrackerAdapter | undefined;
  require(key: BackendKey): IssueTrackerAdapter;
  list(): IssueTrackerAdapter[];
}

export function createMessagingRegistry(): MessagingRegistry {
  const byKey = new Map<BackendKey, IssueTrackerAdapter>();
  return {
    register(adapter) {
      if (byKey.has(adapter.backendKey)) {
        throw new Error(`messaging adapter '${adapter.backendKey}' already registered`);
      }
      byKey.set(adapter.backendKey, adapter);
    },
    unregister(key) {
      byKey.delete(key);
    },
    get(key) {
      return byKey.get(key);
    },
    require(key) {
      const found = byKey.get(key);
      if (!found) throw new Error(`no messaging adapter registered for '${key}'`);
      return found;
    },
    list() {
      return [...byKey.values()];
    },
  };
}

// Process-wide singleton used by server startup.
export const messagingRegistry: MessagingRegistry = createMessagingRegistry();
