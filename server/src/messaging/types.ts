export type BackendKey = "linear" | "fake";

export type MessageRefId = string;
export type ExternalRef = string;

export interface CapabilityFlags {
  supportsEditing: boolean;
  supportsReactions: boolean;
  supportsFileUpload: boolean;
  supportsIssueRelations: boolean;
  supportsLabels: boolean;
  requiresUserAuthPerIdentity: boolean;
}

export type AdapterCredential =
  | { kind: "bot_token"; secretId?: string }
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

export type AuthorKind = "agent" | "user" | "bot_system";

export interface CreateIssueArgs {
  externalTeamRef: ExternalRef;
  externalProjectRef?: ExternalRef | null;
  title: string;
  description?: string | null;
  assigneeExternalRef?: ExternalRef | null;
  stateExternalRef?: ExternalRef | null;
  priority?: number | null;
  labelExternalRefs?: ExternalRef[];
  author: AuthorIdentity;
}

export interface UpdateIssueArgs {
  externalIssueRef: ExternalRef;
  title?: string | null;
  description?: string | null;
  assigneeExternalRef?: ExternalRef | null;
  stateExternalRef?: ExternalRef | null;
  priority?: number | null;
  labelExternalRefs?: ExternalRef[];
  author: AuthorIdentity;
}

export interface IssueRef {
  externalIssueRef: ExternalRef;
  identifier: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Issue {
  externalIssueRef: ExternalRef;
  identifier: string;
  title: string;
  description: string | null;
  stateExternalRef: ExternalRef | null;
  priority: number | null;
  assigneeExternalRef: ExternalRef | null;
  labelExternalRefs: ExternalRef[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PostCommentArgs {
  externalIssueRef: ExternalRef;
  author: AuthorIdentity;
  body: string;
  attachments?: AttachmentRef[];
}

export interface CommentRef {
  externalCommentRef: ExternalRef;
  createdAt: Date;
}

export interface Comment {
  externalCommentRef: ExternalRef;
  externalIssueRef: ExternalRef;
  body: string;
  authorExternalRef: ExternalRef;
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
  reactions?: Record<string, string[]>;
}

export interface PaginationOpts {
  limit?: number;
  afterExternalRef?: ExternalRef;
}

export interface UploadAttachmentArgs {
  externalIssueRef: ExternalRef;
  externalCommentRef?: ExternalRef;
  by: AuthorIdentity;
  title: string;
  /**
   * URL where the attachment bytes are hosted. Linear's attachmentCreate
   * is metadata-only — it stores a pointer to externally-hosted content.
   * Callers upload to their own blob store first and pass the resulting
   * URL here.
   */
  url: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface AttachmentUploadResult {
  externalAttachmentRef: ExternalRef | null;
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

export type MessagingEvent =
  | {
      kind: "issue_created";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      identifier: string;
      title: string | null;
      assigneeExternalRef: ExternalRef | null;
      createdAt: Date;
    }
  | {
      kind: "issue_updated";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      changedFields: string[];
      title?: string | null;
      description?: string | null;
      assigneeExternalRef?: ExternalRef | null;
      stateExternalRef?: ExternalRef | null;
      priority?: number | null;
      updatedAt: Date;
    }
  | {
      kind: "issue_assignee_changed";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      newAssigneeExternalRef: ExternalRef | null;
      updatedAt: Date;
    }
  | {
      kind: "issue_removed";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      removedAt: Date;
    }
  | {
      kind: "comment_created";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      externalCommentRef: ExternalRef;
      authorExternalRef: ExternalRef;
      bodyRaw: string;
      mentionedExternalRefs: ExternalRef[];
      createdAt: Date;
    }
  | {
      kind: "comment_updated";
      externalEventId: string;
      externalCommentRef: ExternalRef;
      externalIssueRef: ExternalRef;
      bodyRaw: string;
      editedAt: Date;
    }
  | {
      kind: "comment_deleted";
      externalEventId: string;
      externalCommentRef: ExternalRef;
      externalIssueRef: ExternalRef;
      deletedAt: Date;
    }
  | {
      kind: "reaction_added" | "reaction_removed";
      externalEventId: string;
      externalCommentRef: ExternalRef;
      externalIssueRef: ExternalRef;
      reactorExternalRef: ExternalRef;
      emoji: string;
      at: Date;
    }
  | {
      kind: "labels_changed";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      addedExternalLabelRefs: ExternalRef[];
      removedExternalLabelRefs: ExternalRef[];
      updatedAt: Date;
    }
  | {
      kind: "attachment_changed";
      externalEventId: string;
      externalIssueRef: ExternalRef;
      externalAttachmentRef: ExternalRef;
      action: "added" | "removed";
      updatedAt: Date;
    }
  | {
      kind: "project_changed";
      externalEventId: string;
      externalProjectRef: ExternalRef;
      action: "created" | "updated" | "removed";
      updatedAt: Date;
    };

export interface IssueTrackerAdapter {
  readonly backendKey: BackendKey;
  readonly capabilities: CapabilityFlags;

  createIssue(args: CreateIssueArgs): Promise<IssueRef>;
  updateIssue(args: UpdateIssueArgs): Promise<IssueRef>;
  getIssue(externalIssueRef: ExternalRef): Promise<Issue | null>;
  archiveIssue(externalIssueRef: ExternalRef): Promise<void>;

  postComment(args: PostCommentArgs): Promise<CommentRef>;
  editComment(externalCommentRef: ExternalRef, body: string): Promise<void>;
  deleteComment(externalCommentRef: ExternalRef, by: AuthorIdentity): Promise<void>;
  getComments(
    externalIssueRef: ExternalRef,
    opts?: PaginationOpts,
  ): Promise<Comment[]>;
  getComment(externalCommentRef: ExternalRef): Promise<Comment | null>;

  /** List issues, optionally filtered by team, assignee, state. */
  listIssues(opts: {
    externalTeamRef?: ExternalRef;
    assigneeExternalRef?: ExternalRef | null;
    stateExternalRef?: ExternalRef | null;
    limit?: number;
    afterExternalRef?: ExternalRef;
  }): Promise<Issue[]>;

  /** Full-text search within a team's issues. */
  searchIssues(opts: {
    externalTeamRef?: ExternalRef;
    query: string;
    limit?: number;
  }): Promise<Issue[]>;

  /** Resolve an identifier like "PLO-5" to a full Issue, or null if not found. */
  getIssueByIdentifier(identifier: string): Promise<Issue | null>;

  ensureLabel(
    companyId: string,
    name: string,
    color?: string | null,
    externalTeamRef?: ExternalRef,
  ): Promise<ExternalRef>;
  setIssueLabels(
    externalIssueRef: ExternalRef,
    externalLabelRefs: ExternalRef[],
  ): Promise<void>;

  uploadAttachment(args: UploadAttachmentArgs): Promise<AttachmentUploadResult>;

  provisionAgentIdentity(args: ProvisionAgentIdentityArgs): Promise<ProvisionResult>;
  resolveExternalUser(externalRef: ExternalRef): Promise<{
    displayName?: string;
    email?: string;
  } | null>;

  normalizeEvent(raw: unknown): MessagingEvent | null;
}

export class MessagingBackendUnavailable extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryAfterSec?: number,
  ) {
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
