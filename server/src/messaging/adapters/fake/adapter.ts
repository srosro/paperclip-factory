import { randomUUID } from "node:crypto";
import type {
  MessagingAdapter,
  CapabilityFlags,
  CreateChannelArgs,
  CreateThreadArgs,
  PostMessageArgs,
  Message,
  MessagingEvent,
  AuthorIdentity,
  ExternalRef,
  ProvisionAgentIdentityArgs,
  ProvisionResult,
} from "../../types.js";

interface FakeChannel {
  ref: string;
  name: string;
  members: Set<string>;
}

interface FakeThread {
  ref: string;
  channelRef: string;
  parentRef: string;
  locked: boolean;
}

interface FakeMessage {
  ref: string;
  channelRef: string;
  threadRef?: string;
  author: string;
  body: string;
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
  reactions: Record<string, Set<string>>;
}

export interface FakeAdapter extends MessagingAdapter {
  onLocalEvent(listener: (e: MessagingEvent) => void): void;
  failNextPost(code: string): void;
  clear(): void;
  /**
   * Test-only: inject a message into the adapter store without emitting a
   * new-message event. Used by the test seed helper so router.getThreadMessages
   * can return bodies alongside ref rows inserted directly by the DB fixture.
   */
  seedMessage(args: {
    ref: string;
    channelRef: string;
    threadRef: string;
    author: string;
    body: string;
    createdAt?: Date;
  }): void;
}

const capabilities: CapabilityFlags = {
  supportsThreads: true,
  supportsEditing: true,
  supportsReactions: true,
  supportsButtons: false,
  supportsFileUpload: false,
  supportsThreadLock: true,
  requiresUserAuthPerIdentity: false,
};

export function createFakeAdapter(): FakeAdapter {
  const channels = new Map<string, FakeChannel>();
  const threads = new Map<string, FakeThread>();
  const messages = new Map<string, FakeMessage>();
  const listeners: Array<(e: MessagingEvent) => void> = [];
  let pendingFailure: string | null = null;

  function emit(e: MessagingEvent) {
    for (const l of listeners) l(e);
  }

  function toMessage(m: FakeMessage): Message {
    return {
      refId: "",
      externalMessageRef: m.ref,
      threadRef: m.threadRef ?? "",
      body: m.body,
      authorExternalRef: m.author,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      reactions: Object.fromEntries(
        Object.entries(m.reactions).map(([k, v]) => [k, [...v]]),
      ),
    };
  }

  return {
    backendKey: "fake",
    capabilities,

    async createChannel(args: CreateChannelArgs) {
      const ref = `C_${randomUUID().slice(0, 8)}`;
      channels.set(ref, { ref, name: args.name, members: new Set() });
      return { externalRef: ref, name: args.name };
    },
    async archiveChannel(ref) {
      channels.delete(ref);
    },
    async addChannelMember(channelRef, identityRef) {
      channels.get(channelRef)?.members.add(identityRef);
    },
    async removeChannelMember(channelRef, identityRef) {
      channels.get(channelRef)?.members.delete(identityRef);
    },
    async createThread(args: CreateThreadArgs) {
      const parentRef = `M_${randomUUID().slice(0, 8)}`;
      const threadRef = parentRef;
      threads.set(threadRef, {
        ref: threadRef,
        channelRef: args.channelRef,
        parentRef,
        locked: false,
      });
      messages.set(parentRef, {
        ref: parentRef,
        channelRef: args.channelRef,
        author: "BOT",
        body: args.fallbackText,
        createdAt: new Date(),
        reactions: {},
      });
      return { threadRef, parentMessageRef: parentRef };
    },
    async lockThread(ref) {
      const t = threads.get(ref);
      if (t) t.locked = true;
    },

    async postMessage(args: PostMessageArgs) {
      if (pendingFailure) {
        const code = pendingFailure;
        pendingFailure = null;
        throw new Error(`fake-fail:${code}`);
      }
      const ref = `M_${randomUUID().slice(0, 8)}`;
      const createdAt = new Date();
      messages.set(ref, {
        ref,
        channelRef: args.channelRef,
        threadRef: args.threadRef,
        author: args.authorIdentity.externalUserRef,
        body: args.body,
        createdAt,
        reactions: {},
      });
      emit({
        kind: "message",
        externalEventId: `E_${randomUUID().slice(0, 8)}`,
        channelRef: args.channelRef,
        threadRef: args.threadRef,
        messageRef: ref,
        authorExternalRef: args.authorIdentity.externalUserRef,
        bodyRaw: args.body,
        createdAt,
      });
      return { messageRef: ref, createdAt };
    },
    async editMessage(_channelRef, ref, body) {
      const m = messages.get(ref);
      if (!m) return;
      m.body = body;
      m.editedAt = new Date();
      emit({
        kind: "message_changed",
        externalEventId: `E_${randomUUID().slice(0, 8)}`,
        messageRef: ref,
        channelRef: m.channelRef,
        bodyRaw: body,
        editedAt: m.editedAt,
      });
    },
    async deleteMessage(_channelRef, ref, _by: AuthorIdentity) {
      const m = messages.get(ref);
      if (!m) return;
      m.deletedAt = new Date();
      emit({
        kind: "message_deleted",
        externalEventId: `E_${randomUUID().slice(0, 8)}`,
        messageRef: ref,
        channelRef: m.channelRef,
        deletedAt: m.deletedAt,
      });
    },
    async getThreadMessages(_channelRef, threadRef: ExternalRef) {
      const all: Message[] = [];
      for (const m of messages.values()) {
        if (m.threadRef === threadRef && !m.deletedAt) {
          all.push(toMessage(m));
        }
      }
      return all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async getMessage(_channelRef, ref) {
      const m = messages.get(ref);
      if (!m) return null;
      return toMessage(m);
    },

    async provisionAgentIdentity(args: ProvisionAgentIdentityArgs): Promise<ProvisionResult> {
      return {
        kind: "completed",
        externalUserRef: `U_${args.agentId.slice(0, 8)}`,
        credential: { kind: "none" },
      };
    },
    async resolveExternalUser() {
      return null;
    },

    normalizeEvent(raw) {
      if (raw && typeof raw === "object" && "kind" in raw) return raw as MessagingEvent;
      return null;
    },

    onLocalEvent(listener) {
      listeners.push(listener);
    },
    failNextPost(code) {
      pendingFailure = code;
    },
    clear() {
      channels.clear();
      threads.clear();
      messages.clear();
      listeners.length = 0;
      pendingFailure = null;
    },
    seedMessage(args) {
      // Idempotent insert used only by tests.
      messages.set(args.ref, {
        ref: args.ref,
        channelRef: args.channelRef,
        threadRef: args.threadRef,
        author: args.author,
        body: args.body,
        createdAt: args.createdAt ?? new Date(),
        reactions: {},
      });
    },
  };
}
