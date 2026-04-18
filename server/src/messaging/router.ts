import { eq, and, gt } from "drizzle-orm";
import type {
  BackendKey,
  AuthorIdentity,
  AdapterCredential,
  AttachmentRef,
  MessagingAdapter,
} from "./types.js";
import { MessagingIdentityNotActive, MessagingThreadLocked } from "./types.js";
import { fallbackCardText, type IssueCardInput } from "./issue-card.js";
import type { createDb } from "@paperclipai/db";
import {
  messagingChannels,
  messagingThreads,
  messagingIdentities,
  messagingMessageRefs,
  issues as issuesTable,
  projects as projectsTable,
} from "@paperclipai/db";

export type Db = ReturnType<typeof createDb>;

export interface RouterDeps {
  db: Db;
  /**
   * The adapter instance this router routes through. Callers resolve one via
   * resolveMessagingContext(companyId) so the adapter is workspace-scoped.
   */
  adapter: MessagingAdapter;
  backend: BackendKey;
  channelNamePrefix?: string;
  /**
   * Optional — public-facing base URL for issue links embedded in thread cards.
   * Example: "https://paperclip.local".
   */
  issueUrlBase?: string;
}

export interface RouterPostArgs {
  companyId: string;
  issueId: string;
  /**
   * Project the issue belongs to. When null, the router provisions an
   * ad-hoc channel keyed on the issueId so comments still have a home.
   */
  projectId: string | null;
  authorAgentId?: string;
  authorUserId?: string;
  body: string;
  createdByRunId?: string;
  blocks?: unknown;
  /**
   * Optional: Paperclip attachments to upload into the Slack thread after
   * the comment posts. Requires the configured adapter to advertise
   * `supportsFileUpload`; otherwise the adapter ignores them.
   */
  attachments?: AttachmentRef[];
}

export interface UploadAttachmentArgs {
  refId: string;
  authorAgentId?: string;
  authorUserId?: string;
  filename: string;
  contentType: string;
  body: Buffer;
}

export interface RouterReadMessage {
  refId: string;
  externalMessageRef: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId: string | null;
  firstSeenAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  suppressedForWake: boolean;
}

export interface MessagingRouter {
  backend: BackendKey;
  getOrCreateChannel(args: {
    companyId: string;
    projectId: string | null;
    issueId?: string;
  }): Promise<{ id: string; externalRef: string }>;
  getOrCreateThread(args: {
    companyId: string;
    issueId: string;
    projectId: string | null;
  }): Promise<{ id: string; threadRef: string; channelId: string }>;
  postMessage(args: RouterPostArgs): Promise<{
    id: string;
    externalMessageRef: string;
    createdAt: Date;
  }>;
  /**
   * Upload an attachment's bytes into the Slack thread the given message ref
   * belongs to. Used by the retroactive attachment-upload HTTP route — agents
   * post a comment first, then POST /attachments with an issueCommentId. This
   * method ships the bytes to the same thread and records the file id on the
   * ref's metadata.
   */
  uploadAttachmentToMessage(args: UploadAttachmentArgs): Promise<{
    slackFileId: string | null;
  }>;
  getThreadMessages(args: {
    issueId: string;
    afterRefId?: string;
  }): Promise<RouterReadMessage[]>;
  onIssueStateChange(issueId: string): Promise<void>;
  /**
   * Update the messaging thread's locked state for an issue. When an issue
   * transitions to `done` / `cancelled`, callers flip this to true so that
   * further comments are rejected by postMessage and dropped by the events
   * processor. Re-opening an issue flips it back to false.
   */
  setThreadLocked(issueId: string, locked: boolean): Promise<void>;
  ensureChannelMember(args: {
    companyId: string;
    projectId: string | null;
    agentId?: string;
    userId?: string;
  }): Promise<void>;
}

export function normalizeChannelName(raw: string, maxLen = 80): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
  return cleaned.length ? cleaned : "proj";
}

function buildCredential(row: {
  authBlobSecretId: string | null;
}): AdapterCredential {
  if (row.authBlobSecretId) {
    return { kind: "user_token", secretId: row.authBlobSecretId };
  }
  return { kind: "none" };
}

export function createMessagingRouter(deps: RouterDeps): MessagingRouter {
  const prefix = deps.channelNamePrefix ?? "proj-";
  const urlBase = deps.issueUrlBase ?? "";
  const adapter = deps.adapter;

  async function loadIdentity(args: {
    companyId: string;
    agentId?: string;
    userId?: string;
  }) {
    const whereClauses = [
      eq(messagingIdentities.backend, deps.backend),
      eq(messagingIdentities.companyId, args.companyId),
    ];
    if (args.agentId) {
      whereClauses.push(eq(messagingIdentities.agentId, args.agentId));
    } else if (args.userId) {
      whereClauses.push(eq(messagingIdentities.userId, args.userId));
    } else {
      return undefined;
    }
    const rows = await deps.db
      .select()
      .from(messagingIdentities)
      .where(and(...whereClauses))
      .limit(1);
    return rows[0];
  }

  async function loadChannel(channelId: string) {
    const rows = await deps.db
      .select()
      .from(messagingChannels)
      .where(eq(messagingChannels.id, channelId))
      .limit(1);
    return rows[0];
  }

  async function loadThread(issueId: string) {
    const rows = await deps.db
      .select()
      .from(messagingThreads)
      .where(eq(messagingThreads.issueId, issueId))
      .limit(1);
    return rows[0];
  }

  async function buildIssueCardInput(issueId: string): Promise<IssueCardInput | null> {
    const rows = await deps.db
      .select()
      .from(issuesTable)
      .where(eq(issuesTable.id, issueId))
      .limit(1);
    const issue = rows[0];
    if (!issue) return null;
    return {
      identifier: issue.identifier ?? issue.id.slice(0, 8),
      title: issue.title ?? "",
      status: issue.status ?? "",
      priority: issue.priority ?? undefined,
      descriptionExcerpt: issue.description?.slice(0, 200) ?? undefined,
      issueUrl: `${urlBase}/issues/${issue.id}`,
    };
  }

  const router: MessagingRouter = {
    backend: deps.backend,

    async getOrCreateChannel({ companyId, projectId, issueId }) {
      if (projectId) {
        const existing = await deps.db
          .select()
          .from(messagingChannels)
          .where(
            and(
              eq(messagingChannels.companyId, companyId),
              eq(messagingChannels.backend, deps.backend),
              eq(messagingChannels.projectId, projectId),
            ),
          )
          .limit(1);
        if (existing[0]) {
          return { id: existing[0].id, externalRef: existing[0].externalChannelRef };
        }

        const projectRows = await deps.db
          .select({ name: projectsTable.name })
          .from(projectsTable)
          .where(eq(projectsTable.id, projectId))
          .limit(1);
        const project = projectRows[0];
        if (!project) throw new Error(`project ${projectId} not found`);


        const nameSource = project.name ?? "proj";
        const name = normalizeChannelName(prefix + nameSource);
        const created = await adapter.createChannel({ name, purpose: "project" });

        const [row] = await deps.db
          .insert(messagingChannels)
          .values({
            companyId,
            backend: deps.backend,
            purpose: "project",
            projectId,
            externalChannelRef: created.externalRef,
            externalChannelName: created.name,
          })
          .returning();
        return { id: row!.id, externalRef: row!.externalChannelRef };
      }

      // Ad-hoc channel keyed on issueId for issues without a project.
      if (!issueId) throw new Error("getOrCreateChannel: need projectId or issueId");
      const adhocExternalRef = `C_adhoc_${issueId}`;
      const existingAdhoc = await deps.db
        .select()
        .from(messagingChannels)
        .where(
          and(
            eq(messagingChannels.backend, deps.backend),
            eq(messagingChannels.externalChannelRef, adhocExternalRef),
          ),
        )
        .limit(1);
      if (existingAdhoc[0]) {
        return { id: existingAdhoc[0].id, externalRef: existingAdhoc[0].externalChannelRef };
      }


      const name = normalizeChannelName(`${prefix}issue-${issueId.slice(0, 8)}`);
      const created = await adapter.createChannel({ name, purpose: "ad_hoc" });

      const [adhocRow] = await deps.db
        .insert(messagingChannels)
        .values({
          companyId,
          backend: deps.backend,
          purpose: "ad_hoc",
          externalChannelRef: created.externalRef,
          externalChannelName: created.name,
        })
        .returning();
      return { id: adhocRow!.id, externalRef: adhocRow!.externalChannelRef };
    },

    async getOrCreateThread({ companyId, issueId, projectId }) {
      const existing = await loadThread(issueId);
      if (existing) {
        return {
          id: existing.id,
          threadRef: existing.externalThreadRef,
          channelId: existing.channelId,
        };
      }

      const channel = await this.getOrCreateChannel({ companyId, projectId, issueId });
      const card = await buildIssueCardInput(issueId);
      if (!card) throw new Error(`issue ${issueId} not found`);


      const created = await adapter.createThread({
        channelRef: channel.externalRef,
        parentBlocks: null,
        fallbackText: fallbackCardText(card),
      });

      const [row] = await deps.db
        .insert(messagingThreads)
        .values({
          issueId,
          channelId: channel.id,
          backend: deps.backend,
          externalThreadRef: created.threadRef,
          parentMessageRef: created.parentMessageRef,
        })
        .returning();
      return {
        id: row!.id,
        threadRef: row!.externalThreadRef,
        channelId: row!.channelId,
      };
    },

    async postMessage(args) {
      const thread = await this.getOrCreateThread({
        companyId: args.companyId,
        issueId: args.issueId,
        projectId: args.projectId,
      });

      const threadRow = await loadThread(args.issueId);
      if (threadRow?.state === "locked") {
        throw new MessagingThreadLocked(thread.id);
      }

      const channel = await loadChannel(thread.channelId);
      if (!channel) throw new Error(`channel for thread ${thread.id} not found`);

      // System-authored posts (no agent/user) skip the identity lookup and
      // post as a synthetic SYSTEM principal. Required for heartbeat
      // reconcilers / server-generated status comments.
      let authorIdentity: AuthorIdentity;
      if (!args.authorAgentId && !args.authorUserId) {
        authorIdentity = {
          backend: deps.backend,
          externalUserRef: "SYSTEM",
          credential: { kind: "none" },
        };
      } else {
        const identity = await loadIdentity({
          companyId: args.companyId,
          agentId: args.authorAgentId,
          userId: args.authorUserId,
        });
        if (!identity || identity.state !== "active") {
          throw new MessagingIdentityNotActive(identity?.id ?? "none");
        }
        authorIdentity = {
          backend: deps.backend,
          externalUserRef: identity.externalUserRef,
          credential: buildCredential(identity),
        };
      }


      const posted = await adapter.postMessage({
        channelRef: channel.externalChannelRef,
        threadRef: thread.threadRef,
        authorIdentity,
        body: args.body,
        blocks: args.blocks,
        attachments: args.attachments,
      });

      const metadata: Record<string, unknown> | null =
        posted.slackFileIds && posted.slackFileIds.length > 0
          ? { slackFileIds: posted.slackFileIds }
          : null;

      const [inserted] = await deps.db
        .insert(messagingMessageRefs)
        .values({
          threadId: thread.id,
          backend: deps.backend,
          externalMessageRef: posted.messageRef,
          authorAgentId: args.authorAgentId ?? null,
          authorUserId: args.authorUserId ?? null,
          createdByRunId: args.createdByRunId ?? null,
          metadata,
        })
        .onConflictDoUpdate({
          target: [
            messagingMessageRefs.backend,
            messagingMessageRefs.externalMessageRef,
          ],
          set: {
            authorAgentId: args.authorAgentId ?? null,
            authorUserId: args.authorUserId ?? null,
            createdByRunId: args.createdByRunId ?? null,
            ...(metadata ? { metadata } : {}),
          },
        })
        .returning();
      return {
        id: inserted!.id,
        externalMessageRef: inserted!.externalMessageRef,
        createdAt: posted.createdAt,
      };
    },

    async uploadAttachmentToMessage(args) {
      const rows = await deps.db
        .select()
        .from(messagingMessageRefs)
        .where(eq(messagingMessageRefs.id, args.refId))
        .limit(1);
      const ref = rows[0];
      if (!ref) throw new Error(`message ref ${args.refId} not found`);
      if (ref.backend !== deps.backend) return { slackFileId: null };

      const threadRows = await deps.db
        .select()
        .from(messagingThreads)
        .where(eq(messagingThreads.id, ref.threadId))
        .limit(1);
      const thread = threadRows[0];
      if (!thread) throw new Error(`thread ${ref.threadId} not found`);
      const channel = await loadChannel(thread.channelId);
      if (!channel) throw new Error(`channel for thread ${thread.id} not found`);


      if (!adapter.uploadAttachmentToThread) return { slackFileId: null };

      let authorIdentity: AuthorIdentity;
      if (!args.authorAgentId && !args.authorUserId) {
        authorIdentity = {
          backend: deps.backend,
          externalUserRef: "SYSTEM",
          credential: { kind: "none" },
        };
      } else {
        const identity = await loadIdentity({
          companyId: channel.companyId,
          agentId: args.authorAgentId,
          userId: args.authorUserId,
        });
        if (!identity || identity.state !== "active") {
          throw new MessagingIdentityNotActive(identity?.id ?? "none");
        }
        authorIdentity = {
          backend: deps.backend,
          externalUserRef: identity.externalUserRef,
          credential: buildCredential(identity),
        };
      }

      const uploaded = await adapter.uploadAttachmentToThread({
        channelRef: channel.externalChannelRef,
        threadRef: thread.externalThreadRef,
        by: authorIdentity,
        filename: args.filename,
        contentType: args.contentType,
        body: args.body,
      });

      if (uploaded.slackFileId) {
        const existingMeta = (ref.metadata ?? {}) as Record<string, unknown>;
        const existingIds = Array.isArray(existingMeta.slackFileIds)
          ? (existingMeta.slackFileIds as string[])
          : [];
        const mergedIds = [...existingIds, uploaded.slackFileId];
        await deps.db
          .update(messagingMessageRefs)
          .set({ metadata: { ...existingMeta, slackFileIds: mergedIds } })
          .where(eq(messagingMessageRefs.id, ref.id));
      }
      return { slackFileId: uploaded.slackFileId };
    },

    async getThreadMessages({ issueId, afterRefId }) {
      const thread = await loadThread(issueId);
      if (!thread) return [];

      let afterFirstSeen: Date | null = null;
      if (afterRefId) {
        const [cursorRow] = await deps.db
          .select({ firstSeenAt: messagingMessageRefs.firstSeenAt })
          .from(messagingMessageRefs)
          .where(eq(messagingMessageRefs.id, afterRefId))
          .limit(1);
        if (cursorRow) afterFirstSeen = cursorRow.firstSeenAt;
      }

      const whereClauses = [eq(messagingMessageRefs.threadId, thread.id)];
      if (afterFirstSeen) {
        whereClauses.push(gt(messagingMessageRefs.firstSeenAt, afterFirstSeen));
      }

      const refs = await deps.db
        .select()
        .from(messagingMessageRefs)
        .where(and(...whereClauses))
        .orderBy(messagingMessageRefs.firstSeenAt);


      const channel = await loadChannel(thread.channelId);
      if (!channel) return [];

      const liveMessages = await adapter.getThreadMessages(
        channel.externalChannelRef,
        thread.externalThreadRef,
      );
      const bodyByRef = new Map(
        liveMessages.map((m) => [m.externalMessageRef, m.body]),
      );

      return refs
        .filter((r) => !r.deletedAt)
        .map((r) => ({
          refId: r.id,
          externalMessageRef: r.externalMessageRef,
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

    async setThreadLocked(issueId: string, locked: boolean) {
      const thread = await loadThread(issueId);
      if (!thread) return;
      const nextState = locked ? "locked" : "open";
      if (thread.state === nextState) return;
      await deps.db
        .update(messagingThreads)
        .set({ state: nextState, updatedAt: new Date() })
        .where(eq(messagingThreads.id, thread.id));
      // Adapter-side lockThread is a best-effort (Slack has no native lock;
      // FakeAdapter flips an internal flag). Errors are logged and swallowed.
      if (locked) {
        try {

          await adapter.lockThread(thread.externalThreadRef);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`messaging: adapter.lockThread failed for ${issueId}`, err);
        }
      }
    },

    async onIssueStateChange(issueId) {
      const thread = await loadThread(issueId);
      if (!thread) return;
      const channel = await loadChannel(thread.channelId);
      if (!channel) return;

      const card = await buildIssueCardInput(issueId);
      if (!card) return;


      try {
        await adapter.editMessage(
          channel.externalChannelRef,
          thread.parentMessageRef,
          fallbackCardText(card),
        );
      } catch (err) {
        // Card update is fire-and-forget; log but do not fail caller.
        // eslint-disable-next-line no-console
        console.warn(`messaging: issue card edit failed for ${issueId}`, err);
      }
    },

    async ensureChannelMember({ companyId, projectId, agentId, userId }) {
      const channel = await this.getOrCreateChannel({ companyId, projectId, issueId: undefined });
      const identity = await loadIdentity({ companyId, agentId, userId });
      if (!identity || identity.state !== "active") return;

      await adapter.addChannelMember(channel.externalRef, identity.externalUserRef);
    },
  };

  return router;
}
