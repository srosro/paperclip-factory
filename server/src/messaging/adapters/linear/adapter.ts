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
import { createLinearClient, type LinearClient } from "./client.js";
import { normalizeLinearEvent } from "./events-normalize.js";
import { selfOriginationTracker } from "./self-origination.js";
import {
  MUTATION_ATTACHMENT_CREATE,
  MUTATION_COMMENT_CREATE,
  MUTATION_COMMENT_DELETE,
  MUTATION_COMMENT_UPDATE,
  MUTATION_ISSUE_ARCHIVE,
  MUTATION_ISSUE_CREATE,
  MUTATION_ISSUE_LABEL_CREATE,
  MUTATION_ISSUE_UPDATE,
  QUERY_COMMENT,
  QUERY_COMMENTS,
  QUERY_ISSUE,
  QUERY_ISSUE_BY_IDENTIFIER,
  QUERY_ISSUE_SEARCH,
  QUERY_ISSUES,
  QUERY_TEAM_LABELS,
} from "./graphql.js";
import type { LinearCommentRaw, LinearIssueRaw } from "./types.js";

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

function rawToIssueRef(issue: LinearIssueRaw): IssueRef {
  return {
    externalIssueRef: issue.id,
    identifier: issue.identifier,
    createdAt: new Date(issue.createdAt),
    updatedAt: new Date(issue.updatedAt),
  };
}

function rawToIssue(issue: LinearIssueRaw): Issue {
  return {
    externalIssueRef: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    stateExternalRef: issue.state?.id ?? null,
    priority: issue.priority ?? null,
    assigneeExternalRef: issue.assignee?.id ?? null,
    labelExternalRefs: issue.labels?.nodes.map((l) => l.id) ?? [],
    createdAt: new Date(issue.createdAt),
    updatedAt: new Date(issue.updatedAt),
  };
}

function rawToComment(raw: LinearCommentRaw, fallbackIssueRef?: string): Comment {
  return {
    externalCommentRef: raw.id,
    externalIssueRef: raw.issue?.id ?? fallbackIssueRef ?? "",
    body: raw.body,
    authorExternalRef: raw.user?.id ?? "",
    createdAt: new Date(raw.createdAt),
    editedAt: raw.editedAt ? new Date(raw.editedAt) : undefined,
  };
}

export function createLinearAdapter(deps: LinearAdapterDeps): IssueTrackerAdapter {
  function makeClient(token: string): LinearClient {
    return deps.clientFactory
      ? deps.clientFactory(token)
      : createLinearClient({ token });
  }

  async function clientForAuthor(author: AuthorIdentity): Promise<LinearClient> {
    const token =
      author.credential.kind === "user_token"
        ? await deps.getUserToken(
            requireCompanyId(deps),
            author.credential.secretId,
          )
        : await deps.getWorkspaceToken(requireCompanyId(deps));
    return makeClient(token);
  }

  async function workspaceClient(): Promise<LinearClient> {
    const token = await deps.getWorkspaceToken(requireCompanyId(deps));
    return makeClient(token);
  }

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

    async createIssue(args: CreateIssueArgs): Promise<IssueRef> {
      const client = await clientForAuthor(args.author);
      const input: Record<string, unknown> = {
        teamId: args.externalTeamRef,
        title: args.title,
      };
      if (args.description != null) input.description = args.description;
      if (args.assigneeExternalRef != null) input.assigneeId = args.assigneeExternalRef;
      if (args.stateExternalRef != null) input.stateId = args.stateExternalRef;
      if (args.priority != null) input.priority = args.priority;
      if (args.labelExternalRefs && args.labelExternalRefs.length > 0) {
        input.labelIds = args.labelExternalRefs;
      }
      if (args.externalProjectRef != null) input.projectId = args.externalProjectRef;

      const res = await client.request<{
        issueCreate: { success: boolean; issue: LinearIssueRaw };
      }>(MUTATION_ISSUE_CREATE, { input });
      if (!res.issueCreate.success || !res.issueCreate.issue) {
        throw new Error("Linear issueCreate returned success=false");
      }
      selfOriginationTracker.mark(res.issueCreate.issue.id);
      return rawToIssueRef(res.issueCreate.issue);
    },

    async updateIssue(args: UpdateIssueArgs): Promise<IssueRef> {
      const client = await clientForAuthor(args.author);
      const input: Record<string, unknown> = {};
      if (args.title !== undefined) input.title = args.title ?? undefined;
      if (args.description !== undefined) input.description = args.description ?? undefined;
      if (args.assigneeExternalRef !== undefined) input.assigneeId = args.assigneeExternalRef;
      if (args.stateExternalRef !== undefined) input.stateId = args.stateExternalRef;
      if (args.priority !== undefined) input.priority = args.priority;
      if (args.labelExternalRefs !== undefined) input.labelIds = args.labelExternalRefs;

      const res = await client.request<{
        issueUpdate: { success: boolean; issue: LinearIssueRaw };
      }>(MUTATION_ISSUE_UPDATE, { id: args.externalIssueRef, input });
      if (!res.issueUpdate.success || !res.issueUpdate.issue) {
        throw new Error("Linear issueUpdate returned success=false");
      }
      selfOriginationTracker.mark(res.issueUpdate.issue.id);
      return rawToIssueRef(res.issueUpdate.issue);
    },

    async getIssue(externalIssueRef: ExternalRef): Promise<Issue | null> {
      const client = await workspaceClient();
      const res = await client.request<{ issue: LinearIssueRaw | null }>(
        QUERY_ISSUE,
        { id: externalIssueRef },
      );
      return res.issue ? rawToIssue(res.issue) : null;
    },

    async archiveIssue(externalIssueRef: ExternalRef): Promise<void> {
      const client = await workspaceClient();
      await client.request(MUTATION_ISSUE_ARCHIVE, { id: externalIssueRef });
      selfOriginationTracker.mark(externalIssueRef);
    },

    async postComment(args: PostCommentArgs): Promise<CommentRef> {
      const client = await clientForAuthor(args.author);
      const input: Record<string, unknown> = {
        issueId: args.externalIssueRef,
        body: args.body,
      };
      const res = await client.request<{
        commentCreate: { success: boolean; comment: LinearCommentRaw };
      }>(MUTATION_COMMENT_CREATE, { input });
      if (!res.commentCreate.success || !res.commentCreate.comment) {
        throw new Error("Linear commentCreate returned success=false");
      }
      selfOriginationTracker.mark(res.commentCreate.comment.id);
      return {
        externalCommentRef: res.commentCreate.comment.id,
        createdAt: new Date(res.commentCreate.comment.createdAt),
      };
    },

    async editComment(
      externalCommentRef: ExternalRef,
      body: string,
    ): Promise<void> {
      const client = await workspaceClient();
      await client.request(MUTATION_COMMENT_UPDATE, {
        id: externalCommentRef,
        input: { body },
      });
      selfOriginationTracker.mark(externalCommentRef);
    },

    async deleteComment(
      externalCommentRef: ExternalRef,
      by: AuthorIdentity,
    ): Promise<void> {
      const client = await clientForAuthor(by);
      await client.request(MUTATION_COMMENT_DELETE, { id: externalCommentRef });
      selfOriginationTracker.mark(externalCommentRef);
    },

    async getComments(
      externalIssueRef: ExternalRef,
      opts?: PaginationOpts,
    ): Promise<Comment[]> {
      const client = await workspaceClient();
      const first = opts?.limit ?? 50;
      const res = await client.request<{
        issue: { comments: { nodes: LinearCommentRaw[] } } | null;
      }>(QUERY_COMMENTS, {
        issueId: externalIssueRef,
        first,
        after: opts?.afterExternalRef ?? null,
      });
      const nodes = res.issue?.comments.nodes ?? [];
      return nodes
        .map((n) => rawToComment(n, externalIssueRef))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async getComment(externalCommentRef: ExternalRef): Promise<Comment | null> {
      const client = await workspaceClient();
      const res = await client.request<{ comment: LinearCommentRaw | null }>(
        QUERY_COMMENT,
        { id: externalCommentRef },
      );
      return res.comment ? rawToComment(res.comment) : null;
    },

    async listIssues(opts) {
      const client = await workspaceClient();
      const filter: Record<string, unknown> = {};
      if (opts.externalTeamRef != null) filter.team = { id: { eq: opts.externalTeamRef } };
      if (opts.assigneeExternalRef !== undefined) {
        filter.assignee = opts.assigneeExternalRef === null
          ? { null: true }
          : { id: { eq: opts.assigneeExternalRef } };
      }
      if (opts.stateExternalRef != null) filter.state = { id: { eq: opts.stateExternalRef } };

      const res = await client.request<{
        issues: { nodes: LinearIssueRaw[] };
      }>(QUERY_ISSUES, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first: opts.limit ?? 50,
        after: opts.afterExternalRef ?? null,
      });
      return (res.issues.nodes ?? []).map(rawToIssue);
    },

    async searchIssues(opts) {
      const client = await workspaceClient();
      const res = await client.request<{
        issueSearch: { nodes: LinearIssueRaw[] };
      }>(QUERY_ISSUE_SEARCH, {
        teamId: opts.externalTeamRef ?? null,
        query: opts.query,
        first: opts.limit ?? 50,
      });
      return (res.issueSearch.nodes ?? []).map(rawToIssue);
    },

    async getIssueByIdentifier(identifier) {
      const client = await workspaceClient();
      const res = await client.request<{
        issueByIdentifier: LinearIssueRaw | null;
      }>(QUERY_ISSUE_BY_IDENTIFIER, { identifier });
      return res.issueByIdentifier ? rawToIssue(res.issueByIdentifier) : null;
    },

    async ensureLabel(
      _companyId: string,
      name: string,
      color?: string | null,
      externalTeamRef?: ExternalRef,
    ): Promise<ExternalRef> {
      if (!externalTeamRef) {
        throw new Error("ensureLabel requires externalTeamRef for Linear");
      }
      const client = await workspaceClient();
      const existing = await client.request<{
        team: { labels: { nodes: Array<{ id: string; name: string }> } } | null;
      }>(QUERY_TEAM_LABELS, { teamId: externalTeamRef });
      const hit = existing.team?.labels.nodes.find((l) => l.name === name);
      if (hit) return hit.id;

      const created = await client.request<{
        issueLabelCreate: { success: boolean; issueLabel: { id: string } };
      }>(MUTATION_ISSUE_LABEL_CREATE, {
        input: { name, teamId: externalTeamRef, color: color ?? undefined },
      });
      if (!created.issueLabelCreate.success) {
        throw new Error("Linear issueLabelCreate returned success=false");
      }
      return created.issueLabelCreate.issueLabel.id;
    },

    async setIssueLabels(
      externalIssueRef: ExternalRef,
      externalLabelRefs: ExternalRef[],
    ): Promise<void> {
      const client = await workspaceClient();
      await client.request(MUTATION_ISSUE_UPDATE, {
        id: externalIssueRef,
        input: { labelIds: externalLabelRefs },
      });
      selfOriginationTracker.mark(externalIssueRef);
    },

    async uploadAttachment(
      args: UploadAttachmentArgs,
    ): Promise<AttachmentUploadResult> {
      const client = await clientForAuthor(args.by);
      const input: Record<string, unknown> = {
        issueId: args.externalIssueRef,
        title: args.title,
        url: args.url,
      };
      if (args.contentType) input.metadata = { contentType: args.contentType };
      const res = await client.request<{
        attachmentCreate: {
          success: boolean;
          attachment: { id: string } | null;
        };
      }>(MUTATION_ATTACHMENT_CREATE, { input });
      return {
        externalAttachmentRef: res.attachmentCreate.attachment?.id ?? null,
      };
    },

    async provisionAgentIdentity(
      args: ProvisionAgentIdentityArgs,
    ): Promise<ProvisionResult> {
      // Delegation: the actual OAuth redirect is handled by
      // routes/messaging-linear.ts (Task 12). This method's role is to return
      // the start URL callers can redirect the user to.
      const startUrl = `/api/messaging/linear/oauth/user/start?agentId=${encodeURIComponent(args.agentId)}`;
      return {
        kind: "needs_user_action",
        redirectUrl: startUrl,
        stateToken: "see-oauth-flow",
      };
    },

    async resolveExternalUser(
      externalRef: ExternalRef,
    ): Promise<{ displayName?: string; email?: string } | null> {
      const client = await workspaceClient();
      const res = await client.request<{
        user: { id: string; name: string; email?: string } | null;
      }>(
        `query User($id: String!) { user(id: $id) { id name email } }`,
        { id: externalRef },
      );
      if (!res.user) return null;
      return { displayName: res.user.name, email: res.user.email };
    },

    normalizeEvent(raw: unknown): MessagingEvent | null {
      return normalizeLinearEvent(raw);
    },
  };
}
