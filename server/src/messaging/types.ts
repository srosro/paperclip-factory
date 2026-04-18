export type BackendKey = "slack" | "fake";

export type ChannelPurpose = "project" | "inbox" | "ad_hoc";

export type MessageRefId = string;      // Paperclip UUID
export type ExternalRef = string;       // backend-specific opaque ref

export interface CapabilityFlags {
  supportsThreads: boolean;
  supportsEditing: boolean;
  supportsReactions: boolean;
  supportsButtons: boolean;
  supportsFileUpload: boolean;
  supportsThreadLock: boolean;
  requiresUserAuthPerIdentity: boolean;
}

export type AdapterCredential =
  | { kind: "bot_token"; secretId: string }
  | { kind: "user_token"; secretId: string }
  | { kind: "none" };

export interface AuthorIdentity {
  backend: BackendKey;
  externalUserRef: ExternalRef;
  credential: AdapterCredential;
}

export interface AttachmentRef {
  paperclipAttachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface PostMessageArgs {
  channelRef: ExternalRef;
  threadRef?: ExternalRef;
  authorIdentity: AuthorIdentity;
  body: string;
  blocks?: unknown;
  attachments?: AttachmentRef[];
}

export interface CreateChannelArgs {
  name: string;
  purpose: ChannelPurpose;
  purposeText?: string;
  private?: boolean;
}

export interface CreateThreadArgs {
  channelRef: ExternalRef;
  parentBlocks: unknown;
  fallbackText: string;
}

export interface ProvisionAgentIdentityArgs {
  companyId: string;
  agentId: string;
  displayName: string;
  email?: string;
}

export type ProvisionResult =
  | { kind: "completed"; externalUserRef: ExternalRef; credential: AdapterCredential }
  | { kind: "needs_user_action"; redirectUrl: string; stateToken: string };

export interface Message {
  refId: MessageRefId;
  externalMessageRef: ExternalRef;
  threadRef: ExternalRef;
  body: string;
  blocks?: unknown;
  authorExternalRef: ExternalRef;
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
  reactions?: Record<string, string[]>;
}

export interface IncomingFileRef {
  id: string;
  name: string;
  mimetype: string;
  urlPrivate: string;
  size: number;
  user?: string;
}

export type MessagingEvent =
  | {
      kind: "message";
      externalEventId: string;
      channelRef: ExternalRef;
      threadRef?: ExternalRef;
      messageRef: ExternalRef;
      authorExternalRef: ExternalRef;
      bodyRaw: string;
      createdAt: Date;
      files?: IncomingFileRef[];
    }
  | {
      kind: "message_changed";
      externalEventId: string;
      messageRef: ExternalRef;
      channelRef: ExternalRef;
      bodyRaw: string;
      editedAt: Date;
    }
  | {
      kind: "message_deleted";
      externalEventId: string;
      messageRef: ExternalRef;
      channelRef: ExternalRef;
      deletedAt: Date;
    }
  | {
      kind: "reaction_added" | "reaction_removed";
      externalEventId: string;
      messageRef: ExternalRef;
      channelRef: ExternalRef;
      reactorExternalRef: ExternalRef;
      emoji: string;
      at: Date;
    };

export interface MessagingAdapter {
  readonly backendKey: BackendKey;
  readonly capabilities: CapabilityFlags;

  // Channels / threads
  createChannel(args: CreateChannelArgs): Promise<{ externalRef: ExternalRef; name: string }>;
  archiveChannel(channelRef: ExternalRef): Promise<void>;
  addChannelMember(channelRef: ExternalRef, identityRef: ExternalRef): Promise<void>;
  removeChannelMember(channelRef: ExternalRef, identityRef: ExternalRef): Promise<void>;
  createThread(args: CreateThreadArgs): Promise<{ threadRef: ExternalRef; parentMessageRef: ExternalRef }>;
  lockThread(threadRef: ExternalRef): Promise<void>;

  // Messages
  postMessage(args: PostMessageArgs): Promise<{ messageRef: ExternalRef; createdAt: Date }>;
  editMessage(channelRef: ExternalRef, messageRef: ExternalRef, body: string, blocks?: unknown): Promise<void>;
  deleteMessage(channelRef: ExternalRef, messageRef: ExternalRef, by: AuthorIdentity): Promise<void>;
  getThreadMessages(channelRef: ExternalRef, threadRef: ExternalRef): Promise<Message[]>;
  getMessage(channelRef: ExternalRef, messageRef: ExternalRef): Promise<Message | null>;

  // Identities
  provisionAgentIdentity(args: ProvisionAgentIdentityArgs): Promise<ProvisionResult>;
  resolveExternalUser(externalRef: ExternalRef): Promise<{ displayName?: string; email?: string } | null>;

  // Events (inbound, normalized)
  normalizeEvent(raw: unknown): MessagingEvent | null;
}

export class MessagingBackendUnavailable extends Error {
  constructor(message: string, readonly code: string, readonly retryAfterSec?: number) {
    super(message);
    this.name = "MessagingBackendUnavailable";
  }
}

export class MessagingIdentityNotActive extends Error {
  constructor(readonly identityId: string) {
    super(`messaging identity ${identityId} is not active`);
    this.name = "MessagingIdentityNotActive";
  }
}

export class MessagingNotConfigured extends Error {
  constructor(readonly companyId: string) {
    super(`messaging not configured for company ${companyId}`);
    this.name = "MessagingNotConfigured";
  }
}

export class MessagingThreadLocked extends Error {
  constructor(readonly threadId: string) {
    super(`messaging thread ${threadId} is locked`);
    this.name = "MessagingThreadLocked";
  }
}
