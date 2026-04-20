import { and, eq, gt } from "drizzle-orm";
import type {
  AttachmentRef,
  AuthorIdentity,
  AuthorKind,
  BackendKey,
  ExternalRef,
  IssueTrackerAdapter,
} from "./types.js";
import { MessagingIdentityNotActive } from "./types.js";
import type { createDb } from "@paperclipai/db";
import {
  issues as issuesTable,
  issueCommentRefs,
  messagingIdentities,
} from "@paperclipai/db";

export type Db = ReturnType<typeof createDb>;

export interface RouterDeps {
  db: Db;
  adapter: IssueTrackerAdapter;
  backend: BackendKey;
  workspaceInstallId?: string | null;
  issueUrlBase?: string;
}

export interface RouterPostCommentArgs {
  companyId: string;
  issueId: string;
  authorAgentId?: string;
  authorUserId?: string;
  authorKind?: AuthorKind;
  body: string;
  createdByRunId?: string;
  attachments?: AttachmentRef[];
}

export interface RouterCreateIssueArgs {
  companyId: string;
  title: string;
  description?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  projectId?: string | null;
  authorAgentId?: string;
  authorUserId?: string;
  authorKind?: AuthorKind;
  priority?: number;
  labelIds?: string[];
}

export interface RouterUpdateIssueArgs {
  companyId: string;
  issueId: string;
  title?: string | null;
  description?: string | null;
  assigneeAgentId?: string | null;
  status?: string | null;
  priority?: number | null;
  authorAgentId?: string;
  authorUserId?: string;
  authorKind?: AuthorKind;
}

export interface RouterReadComment {
  refId: string;
  externalCommentRef: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId: string | null;
  firstSeenAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  suppressedForWake: boolean;
}

export interface IssueTrackerRouter {
  backend: BackendKey;
  createIssue(args: RouterCreateIssueArgs): Promise<{ issueId: string; identifier: string }>;
  updateIssue(args: RouterUpdateIssueArgs): Promise<void>;
  postComment(args: RouterPostCommentArgs): Promise<{
    id: string;
    externalCommentRef: string;
    createdAt: Date;
  }>;
  editComment(args: { refId: string; body: string }): Promise<void>;
  deleteComment(args: { refId: string; by: AuthorIdentity }): Promise<void>;
  getComments(args: {
    issueId: string;
    afterRefId?: string;
  }): Promise<RouterReadComment[]>;
}

function buildCredential(row: { authBlobSecretId: string | null }) {
  if (row.authBlobSecretId) {
    return { kind: "user_token" as const, secretId: row.authBlobSecretId };
  }
  return { kind: "none" as const };
}

export function createIssueTrackerRouter(deps: RouterDeps): IssueTrackerRouter {
  const adapter = deps.adapter;
  const workspaceInstallId = deps.workspaceInstallId ?? null;

  async function loadIdentity(args: {
    companyId: string;
    agentId?: string;
    userId?: string;
  }) {
    const whereClauses = [
      eq(messagingIdentities.backend, deps.backend),
      eq(messagingIdentities.companyId, args.companyId),
    ];
    if (workspaceInstallId) {
      whereClauses.push(
        eq(messagingIdentities.workspaceInstallId, workspaceInstallId),
      );
    }
    if (args.agentId) {
      whereClauses.push(eq(messagingIdentities.agentId, args.agentId));
    } else if (args.userId) {
      whereClauses.push(eq(messagingIdentities.userId, args.userId));
    } else {
      return undefined;
    }
    const [row] = await deps.db
      .select()
      .from(messagingIdentities)
      .where(and(...whereClauses))
      .limit(1);
    return row;
  }

  async function resolveAuthorIdentity(args: {
    companyId: string;
    agentId?: string;
    userId?: string;
    kindHint?: AuthorKind;
  }): Promise<AuthorIdentity> {
    const kind: AuthorKind =
      args.kindHint ??
      (args.agentId ? "agent" : args.userId ? "user" : "bot_system");
    if (kind === "bot_system") {
      return {
        backend: deps.backend,
        externalUserRef: "SYSTEM",
        credential:
          deps.backend === "fake" ? { kind: "none" } : { kind: "bot_token" },
      };
    }
    const identity = await loadIdentity({
      companyId: args.companyId,
      agentId: args.agentId,
      userId: args.userId,
    });
    if (!identity) {
      return {
        backend: deps.backend,
        externalUserRef: "SYSTEM",
        credential:
          deps.backend === "fake" ? { kind: "none" } : { kind: "bot_token" },
      };
    }
    if (identity.state !== "active") {
      throw new MessagingIdentityNotActive(identity.id);
    }
    return {
      backend: deps.backend,
      externalUserRef: identity.externalUserRef,
      credential: buildCredential(identity),
    };
  }

  async function requireCachedIssue(issueId: string) {
    const [row] = await deps.db
      .select()
      .from(issuesTable)
      .where(eq(issuesTable.id, issueId))
      .limit(1);
    if (!row) throw new Error(`issue ${issueId} not found in cache`);
    return row;
  }

  /**
   * Lazily ensure the issue exists in the external tracker. If the cached row
   * has no linearIssueId yet, mint one via adapter.createIssue and persist it
   * back to the issues row. Plan B will replace this with a proper cache-sync
   * pipeline that mirrors Paperclip → Linear writes through a single path.
   */
  async function ensureExternalIssue(issueId: string): Promise<{
    externalIssueRef: string;
    issueRow: typeof issuesTable.$inferSelect;
  }> {
    const row = await requireCachedIssue(issueId);
    if (row.linearIssueId) {
      return { externalIssueRef: row.linearIssueId, issueRow: row };
    }
    const created = await adapter.createIssue({
      externalTeamRef: "",
      title: row.title,
      description: row.description ?? null,
      assigneeExternalRef: null,
      stateExternalRef: null,
      priority: null,
      labelExternalRefs: [],
      author: {
        backend: deps.backend,
        externalUserRef: "SYSTEM",
        credential: deps.backend === "fake" ? { kind: "none" } : { kind: "bot_token" },
      },
    });
    await deps.db
      .update(issuesTable)
      .set({
        linearIssueId: created.externalIssueRef,
        linearIssueIdentifier: created.identifier,
      })
      .where(eq(issuesTable.id, issueId));
    return {
      externalIssueRef: created.externalIssueRef,
      issueRow: { ...row, linearIssueId: created.externalIssueRef, linearIssueIdentifier: created.identifier },
    };
  }

  const router: IssueTrackerRouter = {
    backend: deps.backend,

    async createIssue(args) {
      const author = await resolveAuthorIdentity({
        companyId: args.companyId,
        agentId: args.authorAgentId,
        userId: args.authorUserId,
        kindHint: args.authorKind,
      });
      const result = await adapter.createIssue({
        externalTeamRef: "",
        title: args.title,
        description: args.description ?? null,
        assigneeExternalRef: null,
        stateExternalRef: null,
        priority: args.priority ?? null,
        labelExternalRefs: [],
        author,
      });
      return { issueId: "", identifier: result.identifier };
    },

    async updateIssue(args) {
      const ensured = await ensureExternalIssue(args.issueId);
      const author = await resolveAuthorIdentity({
        companyId: args.companyId,
        agentId: args.authorAgentId,
        userId: args.authorUserId,
        kindHint: args.authorKind,
      });
      await adapter.updateIssue({
        externalIssueRef: ensured.externalIssueRef,
        title: args.title ?? undefined,
        description: args.description ?? undefined,
        assigneeExternalRef: args.assigneeAgentId ? undefined : null,
        stateExternalRef: undefined,
        priority: args.priority ?? undefined,
        author,
      });
    },

    async postComment(args) {
      const ensured = await ensureExternalIssue(args.issueId);
      const author = await resolveAuthorIdentity({
        companyId: args.companyId,
        agentId: args.authorAgentId,
        userId: args.authorUserId,
        kindHint: args.authorKind,
      });
      const posted = await adapter.postComment({
        externalIssueRef: ensured.externalIssueRef,
        author,
        body: args.body,
        attachments: args.attachments,
      });
      const [inserted] = await deps.db
        .insert(issueCommentRefs)
        .values({
          issueId: args.issueId,
          backend: deps.backend,
          externalMessageRef: posted.externalCommentRef,
          authorAgentId: args.authorAgentId ?? null,
          authorUserId: args.authorUserId ?? null,
          createdByRunId: args.createdByRunId ?? null,
        })
        .onConflictDoUpdate({
          target: [
            issueCommentRefs.issueId,
            issueCommentRefs.externalMessageRef,
          ],
          set: {
            authorAgentId: args.authorAgentId ?? null,
            authorUserId: args.authorUserId ?? null,
            createdByRunId: args.createdByRunId ?? null,
          },
        })
        .returning();
      return {
        id: inserted!.id,
        externalCommentRef: inserted!.externalMessageRef,
        createdAt: posted.createdAt,
      };
    },

    async editComment(args) {
      const [ref] = await deps.db
        .select()
        .from(issueCommentRefs)
        .where(eq(issueCommentRefs.id, args.refId))
        .limit(1);
      if (!ref) return;
      await adapter.editComment(ref.externalMessageRef, args.body);
    },

    async deleteComment(args) {
      const [ref] = await deps.db
        .select()
        .from(issueCommentRefs)
        .where(eq(issueCommentRefs.id, args.refId))
        .limit(1);
      if (!ref) return;
      await adapter.deleteComment(ref.externalMessageRef, args.by);
    },

    async getComments({ issueId, afterRefId }) {
      let afterFirstSeen: Date | null = null;
      if (afterRefId) {
        const [cursor] = await deps.db
          .select({ firstSeenAt: issueCommentRefs.firstSeenAt })
          .from(issueCommentRefs)
          .where(eq(issueCommentRefs.id, afterRefId))
          .limit(1);
        if (cursor) afterFirstSeen = cursor.firstSeenAt;
      }
      const whereClauses = [eq(issueCommentRefs.issueId, issueId)];
      if (afterFirstSeen) {
        whereClauses.push(gt(issueCommentRefs.firstSeenAt, afterFirstSeen));
      }
      const refs = await deps.db
        .select()
        .from(issueCommentRefs)
        .where(and(...whereClauses))
        .orderBy(issueCommentRefs.firstSeenAt);

      const [cachedIssue] = await deps.db
        .select()
        .from(issuesTable)
        .where(eq(issuesTable.id, issueId))
        .limit(1);
      if (!cachedIssue || !cachedIssue.linearIssueId) {
        return refs
          .filter((r) => !r.deletedAt)
          .map((r) => ({
            refId: r.id,
            externalCommentRef: r.externalMessageRef,
            body: "",
            authorAgentId: r.authorAgentId,
            authorUserId: r.authorUserId,
            createdByRunId: r.createdByRunId,
            firstSeenAt: r.firstSeenAt,
            editedAt: r.editedAt,
            deletedAt: r.deletedAt,
            suppressedForWake: r.suppressedForWake,
          }));
      }
      const live = await adapter.getComments(cachedIssue.linearIssueId);
      const bodyByRef = new Map(live.map((c) => [c.externalCommentRef, c.body]));
      return refs
        .filter((r) => !r.deletedAt)
        .map((r) => ({
          refId: r.id,
          externalCommentRef: r.externalMessageRef,
          body: bodyByRef.get(r.externalMessageRef) ?? "",
          authorAgentId: r.authorAgentId,
          authorUserId: r.authorUserId,
          createdByRunId: r.createdByRunId,
          firstSeenAt: r.firstSeenAt,
          editedAt: r.editedAt,
          deletedAt: r.deletedAt,
          suppressedForWake: r.suppressedForWake,
        }));
    },
  };

  return router;
}

