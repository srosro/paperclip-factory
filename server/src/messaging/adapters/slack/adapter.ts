import type {
  MessagingAdapter,
  CapabilityFlags,
  CreateChannelArgs,
  CreateThreadArgs,
  PostMessageArgs,
  AuthorIdentity,
  ExternalRef,
  Message,
  MessagingEvent,
  ProvisionAgentIdentityArgs,
  ProvisionResult,
} from "../../types.js";

export interface SlackDeps {
  /**
   * Resolve the workspace-level bot token for a given company. The Slack app
   * is installed once per workspace; this returns the stored bot token.
   */
  getBotToken(companyId: string): Promise<string>;
  /**
   * Resolve a per-agent user token by secret id (stored in messaging_identities
   * via the OAuth flow).
   */
  getUserToken(companyId: string, secretId: string): Promise<string>;
  /**
   * Optionally pin company scope for the adapter (many adapter calls carry a
   * companyId through the router). If omitted, the adapter expects each call
   * site to supply whatever secretId-scoped method applies.
   */
  companyId?: string;
  nowMs?: () => number;
}

const capabilities: CapabilityFlags = {
  supportsThreads: true,
  supportsEditing: true,
  supportsReactions: true,
  supportsButtons: true,
  supportsFileUpload: true,
  supportsThreadLock: false,
  requiresUserAuthPerIdentity: true,
};

const NOT_IMPLEMENTED = "slack adapter method not implemented (Part 8)";

/**
 * Phase 1 skeleton. Operations land in Part 8; this file declares the adapter
 * surface so the registry / router can typecheck against it.
 */
export function createSlackAdapter(_deps: SlackDeps): MessagingAdapter {
  void _deps;
  return {
    backendKey: "slack",
    capabilities,

    async createChannel(_args: CreateChannelArgs) {
      throw new Error(NOT_IMPLEMENTED);
    },
    async archiveChannel(_channelRef: ExternalRef) {
      throw new Error(NOT_IMPLEMENTED);
    },
    async addChannelMember(_channelRef: ExternalRef, _identityRef: ExternalRef) {
      throw new Error(NOT_IMPLEMENTED);
    },
    async removeChannelMember(_channelRef: ExternalRef, _identityRef: ExternalRef) {
      throw new Error(NOT_IMPLEMENTED);
    },
    async createThread(_args: CreateThreadArgs): Promise<{
      threadRef: ExternalRef;
      parentMessageRef: ExternalRef;
    }> {
      throw new Error(NOT_IMPLEMENTED);
    },
    async lockThread(_threadRef: ExternalRef) {
      throw new Error(NOT_IMPLEMENTED);
    },

    async postMessage(_args: PostMessageArgs): Promise<{
      messageRef: ExternalRef;
      createdAt: Date;
    }> {
      throw new Error(NOT_IMPLEMENTED);
    },
    async editMessage(
      _channelRef: ExternalRef,
      _messageRef: ExternalRef,
      _body: string,
      _blocks?: unknown,
    ) {
      throw new Error(NOT_IMPLEMENTED);
    },
    async deleteMessage(
      _channelRef: ExternalRef,
      _messageRef: ExternalRef,
      _by: AuthorIdentity,
    ) {
      throw new Error(NOT_IMPLEMENTED);
    },
    async getThreadMessages(
      _channelRef: ExternalRef,
      _threadRef: ExternalRef,
    ): Promise<Message[]> {
      throw new Error(NOT_IMPLEMENTED);
    },
    async getMessage(
      _channelRef: ExternalRef,
      _messageRef: ExternalRef,
    ): Promise<Message | null> {
      throw new Error(NOT_IMPLEMENTED);
    },

    async provisionAgentIdentity(
      _args: ProvisionAgentIdentityArgs,
    ): Promise<ProvisionResult> {
      throw new Error(NOT_IMPLEMENTED);
    },
    async resolveExternalUser(_externalRef: ExternalRef) {
      return null;
    },

    normalizeEvent(_raw: unknown): MessagingEvent | null {
      // Filled in Task 8.5.
      return null;
    },
  };
}
