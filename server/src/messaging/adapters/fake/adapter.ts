import { randomUUID } from "node:crypto";
import type {
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
  AttachmentUploadResult,
  AuthorIdentity,
} from "../../types.js";

type LocalIssue = Issue & { counter: number };
type LocalComment = Comment;
type OnLocalEvent = (e: MessagingEvent) => void;

export interface FakeAdapterState {
  readonly issuesByRef: Map<ExternalRef, LocalIssue>;
  readonly commentsByRef: Map<ExternalRef, LocalComment>;
  readonly labelsByRef: Map<ExternalRef, { name: string; color: string | null }>;
}

export function createFakeAdapter(): IssueTrackerAdapter & {
  onLocalEvent: (cb: OnLocalEvent) => void;
  seedComment: (args: {
    ref: ExternalRef;
    externalIssueRef: ExternalRef;
    author: ExternalRef;
    body: string;
    createdAt?: Date;
  }) => void;
  state: FakeAdapterState;
} {
  const issuesByRef = new Map<ExternalRef, LocalIssue>();
  const commentsByRef = new Map<ExternalRef, LocalComment>();
  const labelsByRef = new Map<ExternalRef, { name: string; color: string | null }>();
  let counter = 0;
  let eventId = 0;
  const localListeners: OnLocalEvent[] = [];
  const emit = (e: MessagingEvent) => {
    for (const l of localListeners) l(e);
  };
  const nextEventId = () => `fake-evt-${++eventId}`;

  return {
    backendKey: "fake",
    capabilities: {
      supportsEditing: true,
      supportsReactions: true,
      supportsFileUpload: false,
      supportsIssueRelations: false,
      supportsLabels: true,
      requiresUserAuthPerIdentity: false,
    },

    async createIssue(args: CreateIssueArgs): Promise<IssueRef> {
      counter += 1;
      const ref = randomUUID();
      const identifier = `FAKE-${counter}`;
      const now = new Date();
      const issue: LocalIssue = {
        externalIssueRef: ref,
        identifier,
        title: args.title,
        description: args.description ?? null,
        stateExternalRef: args.stateExternalRef ?? null,
        priority: args.priority ?? null,
        assigneeExternalRef: args.assigneeExternalRef ?? null,
        labelExternalRefs: args.labelExternalRefs ?? [],
        createdAt: now,
        updatedAt: now,
        counter,
      };
      issuesByRef.set(ref, issue);
      emit({
        kind: "issue_created",
        externalEventId: nextEventId(),
        externalIssueRef: ref,
        identifier,
        assigneeExternalRef: issue.assigneeExternalRef,
        createdAt: now,
      });
      return { externalIssueRef: ref, identifier, createdAt: now, updatedAt: now };
    },

    async updateIssue(args: UpdateIssueArgs): Promise<IssueRef> {
      const existing = issuesByRef.get(args.externalIssueRef);
      if (!existing) throw new Error(`fake adapter: issue ${args.externalIssueRef} not found`);
      const now = new Date();
      const changed: string[] = [];
      if (args.title !== undefined) {
        existing.title = args.title ?? "";
        changed.push("title");
      }
      if (args.description !== undefined) {
        existing.description = args.description;
        changed.push("description");
      }
      if (args.assigneeExternalRef !== undefined) {
        existing.assigneeExternalRef = args.assigneeExternalRef;
        changed.push("assignee");
      }
      if (args.stateExternalRef !== undefined) {
        existing.stateExternalRef = args.stateExternalRef;
        changed.push("state");
      }
      if (args.priority !== undefined) {
        existing.priority = args.priority;
        changed.push("priority");
      }
      if (args.labelExternalRefs !== undefined) {
        existing.labelExternalRefs = args.labelExternalRefs;
        changed.push("labels");
      }
      existing.updatedAt = now;
      if (changed.includes("assignee")) {
        emit({
          kind: "issue_assignee_changed",
          externalEventId: nextEventId(),
          externalIssueRef: existing.externalIssueRef,
          newAssigneeExternalRef: existing.assigneeExternalRef,
          updatedAt: now,
        });
      } else {
        emit({
          kind: "issue_updated",
          externalEventId: nextEventId(),
          externalIssueRef: existing.externalIssueRef,
          changedFields: changed,
          assigneeExternalRef: existing.assigneeExternalRef,
          stateExternalRef: existing.stateExternalRef,
          updatedAt: now,
        });
      }
      return {
        externalIssueRef: existing.externalIssueRef,
        identifier: existing.identifier,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
    },

    async getIssue(externalIssueRef: ExternalRef): Promise<Issue | null> {
      const found = issuesByRef.get(externalIssueRef);
      return found ? { ...found } : null;
    },

    async archiveIssue(externalIssueRef: ExternalRef): Promise<void> {
      issuesByRef.delete(externalIssueRef);
    },

    async postComment(args: PostCommentArgs): Promise<CommentRef> {
      counter += 1;
      const ref = randomUUID();
      const now = new Date();
      commentsByRef.set(ref, {
        externalCommentRef: ref,
        externalIssueRef: args.externalIssueRef,
        body: args.body,
        authorExternalRef: args.author.externalUserRef,
        createdAt: now,
      });
      emit({
        kind: "comment_created",
        externalEventId: nextEventId(),
        externalIssueRef: args.externalIssueRef,
        externalCommentRef: ref,
        authorExternalRef: args.author.externalUserRef,
        bodyRaw: args.body,
        mentionedExternalRefs: [],
        createdAt: now,
      });
      return { externalCommentRef: ref, createdAt: now };
    },

    async editComment(externalCommentRef: ExternalRef, body: string): Promise<void> {
      const c = commentsByRef.get(externalCommentRef);
      if (!c) return;
      c.body = body;
      c.editedAt = new Date();
      emit({
        kind: "comment_updated",
        externalEventId: nextEventId(),
        externalCommentRef,
        externalIssueRef: c.externalIssueRef,
        bodyRaw: body,
        editedAt: c.editedAt,
      });
    },

    async deleteComment(externalCommentRef: ExternalRef, _by: AuthorIdentity): Promise<void> {
      const c = commentsByRef.get(externalCommentRef);
      if (!c) return;
      c.deletedAt = new Date();
      emit({
        kind: "comment_deleted",
        externalEventId: nextEventId(),
        externalCommentRef,
        externalIssueRef: c.externalIssueRef,
        deletedAt: c.deletedAt,
      });
    },

    async getComments(
      externalIssueRef: ExternalRef,
      _opts?: PaginationOpts,
    ): Promise<Comment[]> {
      return [...commentsByRef.values()]
        .filter((c) => c.externalIssueRef === externalIssueRef)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async getComment(externalCommentRef: ExternalRef): Promise<Comment | null> {
      return commentsByRef.get(externalCommentRef) ?? null;
    },

    async ensureLabel(
      _companyId: string,
      name: string,
      color?: string | null,
    ): Promise<ExternalRef> {
      const existing = [...labelsByRef.entries()].find(([, l]) => l.name === name);
      if (existing) return existing[0];
      counter += 1;
      const ref = `L_${counter}`;
      labelsByRef.set(ref, { name, color: color ?? null });
      return ref;
    },

    async setIssueLabels(
      externalIssueRef: ExternalRef,
      externalLabelRefs: ExternalRef[],
    ): Promise<void> {
      const issue = issuesByRef.get(externalIssueRef);
      if (!issue) return;
      const added = externalLabelRefs.filter(
        (r) => !issue.labelExternalRefs.includes(r),
      );
      const removed = issue.labelExternalRefs.filter(
        (r) => !externalLabelRefs.includes(r),
      );
      issue.labelExternalRefs = [...externalLabelRefs];
      emit({
        kind: "labels_changed",
        externalEventId: nextEventId(),
        externalIssueRef,
        addedExternalLabelRefs: added,
        removedExternalLabelRefs: removed,
        updatedAt: new Date(),
      });
    },

    async uploadAttachment(
      _args: UploadAttachmentArgs,
    ): Promise<AttachmentUploadResult> {
      return { externalAttachmentRef: null };
    },

    async provisionAgentIdentity(
      _args: ProvisionAgentIdentityArgs,
    ): Promise<ProvisionResult> {
      const ref = `U_fake_${Math.random().toString(36).slice(2, 8)}`;
      return {
        kind: "completed",
        externalUserRef: ref,
        credential: { kind: "none" },
      };
    },

    async resolveExternalUser(
      _externalRef: ExternalRef,
    ): Promise<{ displayName?: string; email?: string } | null> {
      return null;
    },

    normalizeEvent(_raw: unknown): MessagingEvent | null {
      return null;
    },

    onLocalEvent(cb: OnLocalEvent) {
      localListeners.push(cb);
    },
    seedComment(args: {
      ref: ExternalRef;
      externalIssueRef: ExternalRef;
      author: ExternalRef;
      body: string;
      createdAt?: Date;
    }) {
      commentsByRef.set(args.ref, {
        externalCommentRef: args.ref,
        externalIssueRef: args.externalIssueRef,
        body: args.body,
        authorExternalRef: args.author,
        createdAt: args.createdAt ?? new Date(),
      });
    },
    state: { issuesByRef, commentsByRef, labelsByRef },
  };
}
