import type {
  AttachmentUploadResult,
  AuthorIdentity,
  Comment,
  CommentRef,
  CreateIssueArgs,
  ExternalRef,
  Issue,
  IssueRef,
  IssueTrackerAdapter,
  MessagingEvent,
  PaginationOpts,
  PostCommentArgs,
  ProvisionAgentIdentityArgs,
  ProvisionResult,
  UpdateIssueArgs,
  UploadAttachmentArgs,
} from "../../types.js";
import type { LinearClient } from "./client.js";

export interface LinearAdapterDeps {
  /** Resolves the workspace-level OAuth access token (one per company install). */
  getWorkspaceToken(companyId: string): Promise<string>;
  /** Resolves a per-agent user-scoped OAuth token by secret id. */
  getUserToken(companyId: string, secretId: string): Promise<string>;
  /** Company the adapter instance is scoped to. */
  companyId?: string;
  nowMs?: () => number;
  /** Optional client factory for tests; defaults to createLinearClient. */
  clientFactory?: (token: string) => LinearClient;
}

function requireCompanyId(deps: LinearAdapterDeps): string {
  if (!deps.companyId) {
    throw new Error(
      "Linear adapter requires companyId in deps for workspace-scoped operations",
    );
  }
  return deps.companyId;
}

export function createLinearAdapter(deps: LinearAdapterDeps): IssueTrackerAdapter {
  return {
    backendKey: "linear",
    capabilities: {
      supportsEditing: true,
      supportsReactions: true,
      supportsFileUpload: true,
      supportsIssueRelations: true,
      supportsLabels: true,
      requiresUserAuthPerIdentity: true,
    },

    async createIssue(_args: CreateIssueArgs): Promise<IssueRef> {
      throw new Error("LinearAdapter.createIssue not implemented (Task 6)");
    },
    async updateIssue(_args: UpdateIssueArgs): Promise<IssueRef> {
      throw new Error("LinearAdapter.updateIssue not implemented (Task 6)");
    },
    async getIssue(_externalIssueRef: ExternalRef): Promise<Issue | null> {
      throw new Error("LinearAdapter.getIssue not implemented (Task 6)");
    },
    async archiveIssue(_externalIssueRef: ExternalRef): Promise<void> {
      throw new Error("LinearAdapter.archiveIssue not implemented (Task 6)");
    },

    async postComment(_args: PostCommentArgs): Promise<CommentRef> {
      throw new Error("LinearAdapter.postComment not implemented (Task 7)");
    },
    async editComment(_externalCommentRef: ExternalRef, _body: string): Promise<void> {
      throw new Error("LinearAdapter.editComment not implemented (Task 7)");
    },
    async deleteComment(
      _externalCommentRef: ExternalRef,
      _by: AuthorIdentity,
    ): Promise<void> {
      throw new Error("LinearAdapter.deleteComment not implemented (Task 7)");
    },
    async getComments(
      _externalIssueRef: ExternalRef,
      _opts?: PaginationOpts,
    ): Promise<Comment[]> {
      throw new Error("LinearAdapter.getComments not implemented (Task 7)");
    },
    async getComment(_externalCommentRef: ExternalRef): Promise<Comment | null> {
      throw new Error("LinearAdapter.getComment not implemented (Task 7)");
    },

    async ensureLabel(
      _companyId: string,
      _name: string,
      _color?: string | null,
    ): Promise<ExternalRef> {
      throw new Error("LinearAdapter.ensureLabel not implemented (Task 8)");
    },
    async setIssueLabels(
      _externalIssueRef: ExternalRef,
      _externalLabelRefs: ExternalRef[],
    ): Promise<void> {
      throw new Error("LinearAdapter.setIssueLabels not implemented (Task 8)");
    },

    async uploadAttachment(_args: UploadAttachmentArgs): Promise<AttachmentUploadResult> {
      throw new Error("LinearAdapter.uploadAttachment not implemented (Task 9)");
    },

    async provisionAgentIdentity(
      _args: ProvisionAgentIdentityArgs,
    ): Promise<ProvisionResult> {
      throw new Error("LinearAdapter.provisionAgentIdentity not implemented (Task 10)");
    },
    async resolveExternalUser(
      _externalRef: ExternalRef,
    ): Promise<{ displayName?: string; email?: string } | null> {
      throw new Error("LinearAdapter.resolveExternalUser not implemented (Task 10)");
    },

    normalizeEvent(_raw: unknown): MessagingEvent | null {
      throw new Error("LinearAdapter.normalizeEvent not implemented (Task 14)");
    },
  };
  void requireCompanyId;
}
