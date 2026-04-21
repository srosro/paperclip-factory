import { eq, isNull } from "drizzle-orm";
import { issues as issuesTable } from "@paperclipai/db";
import type { IssueTrackerAdapter, Issue } from "../messaging/types.js";
import type { Db } from "../messaging/router.js";

export interface LinearBackedIssueServiceDeps {
  adapter: IssueTrackerAdapter;
  db: Db;
  companyId: string;
  externalTeamRef: string;
  systemUserRef?: string;
}

export interface LinearBackedIssue extends Issue {
  id: string;
  companyId: string;
  linearIssueId: string | null;
  linearIssueIdentifier: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: Record<string, unknown> | null;
  executionState: Record<string, unknown> | null;
  goalId: string | null;
  projectId: string | null;
  hiddenAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

type CreateArgs = {
  title: string;
  description?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  executionPolicy?: Record<string, unknown> | null;
  goalId?: string | null;
  projectId?: string | null;
  parentId?: string | null;
  stateExternalRef?: string | null;
  priority?: number | null;
};

type UpdateArgs = {
  title?: string | null;
  description?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  executionPolicy?: Record<string, unknown> | null;
  executionState?: Record<string, unknown> | null;
  stateExternalRef?: string | null;
  priority?: number | null;
  hiddenAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
};

type ListOpts = {
  assigneeAgentId?: string | null;
  limit?: number;
};

function systemAuthor(backendKey: import("../messaging/types.js").BackendKey, userRef: string) {
  return {
    backend: backendKey,
    externalUserRef: userRef,
    credential: { kind: "none" as const },
  };
}

export function createLinearBackedIssueService(deps: LinearBackedIssueServiceDeps) {
  const { adapter, db, companyId, externalTeamRef } = deps;
  const systemRef = deps.systemUserRef ?? "system";

  // sidecar is nullable only at call sites where the issue may not yet have a sidecar
  // (getByLinearId, getByIdentifier fallback, list without assigneeAgentId filter).
  // Call sites that require a sidecar (create, getById, update) throw before calling this.
  function mergeSidecar(
    linearIssue: Issue,
    sidecar: typeof issuesTable.$inferSelect | null,
  ): LinearBackedIssue {
    return {
      ...linearIssue,
      // id is null when no sidecar exists (issue lives only in Linear, not in Paperclip yet)
      id: sidecar?.id as string,
      companyId,
      linearIssueId: sidecar?.linearIssueId ?? linearIssue.externalIssueRef,
      linearIssueIdentifier: sidecar?.linearIssueIdentifier ?? linearIssue.identifier,
      assigneeAgentId: sidecar?.assigneeAgentId ?? null,
      assigneeUserId: sidecar?.assigneeUserId ?? null,
      executionPolicy: (sidecar?.executionPolicy as Record<string, unknown> | null) ?? null,
      executionState: (sidecar?.executionState as Record<string, unknown> | null) ?? null,
      goalId: sidecar?.goalId ?? null,
      projectId: sidecar?.projectId ?? null,
      hiddenAt: sidecar?.hiddenAt ?? null,
      startedAt: sidecar?.startedAt ?? null,
      completedAt: sidecar?.completedAt ?? null,
      cancelledAt: sidecar?.cancelledAt ?? null,
    };
  }

  async function getSidecarByLinearId(linearIssueId: string) {
    const [row] = await db
      .select()
      .from(issuesTable)
      .where(eq(issuesTable.linearIssueId, linearIssueId))
      .limit(1);
    return row ?? null;
  }

  async function getSidecarById(id: string) {
    const [row] = await db
      .select()
      .from(issuesTable)
      .where(eq(issuesTable.id, id))
      .limit(1);
    return row ?? null;
  }

  return {
    async create(args: CreateArgs): Promise<LinearBackedIssue> {
      const ref = await adapter.createIssue({
        externalTeamRef,
        title: args.title,
        description: args.description ?? undefined,
        stateExternalRef: args.stateExternalRef ?? undefined,
        priority: args.priority ?? undefined,
        author: systemAuthor(adapter.backendKey, systemRef),
      });

      const linearIssue = await adapter.getIssue(ref.externalIssueRef);
      if (!linearIssue) throw new Error(`create: adapter returned null for newly created issue ${ref.externalIssueRef}`);

      const [sidecar] = await db
        .insert(issuesTable)
        .values({
          companyId,
          linearIssueId: ref.externalIssueRef,
          linearIssueIdentifier: ref.identifier,
          assigneeAgentId: args.assigneeAgentId ?? null,
          assigneeUserId: args.assigneeUserId ?? null,
          executionPolicy: args.executionPolicy ?? null,
          goalId: args.goalId ?? null,
          projectId: args.projectId ?? null,
          parentId: args.parentId ?? null,
        })
        .returning();
      if (!sidecar) throw new Error("create: insert returned no row");

      return mergeSidecar(linearIssue, sidecar);
    },

    async getById(id: string): Promise<LinearBackedIssue | null> {
      const sidecar = await getSidecarById(id);
      if (!sidecar) return null;
      if (!sidecar.linearIssueId) throw new Error(`getById: sidecar ${id} has no linearIssueId`);
      const linearIssue = await adapter.getIssue(sidecar.linearIssueId);
      if (!linearIssue) return null;
      return mergeSidecar(linearIssue, sidecar);
    },

    async getByLinearId(linearIssueId: string): Promise<LinearBackedIssue | null> {
      const linearIssue = await adapter.getIssue(linearIssueId);
      if (!linearIssue) return null;
      const sidecar = await getSidecarByLinearId(linearIssueId);
      return mergeSidecar(linearIssue, sidecar);
    },

    async getByIdentifier(identifier: string): Promise<LinearBackedIssue | null> {
      // Fast path: sidecar lookup avoids Linear API call for the resolve step
      const [sidecarRow] = await db
        .select()
        .from(issuesTable)
        .where(eq(issuesTable.linearIssueIdentifier, identifier))
        .limit(1);

      if (sidecarRow?.linearIssueId) {
        const linearIssue = await adapter.getIssue(sidecarRow.linearIssueId);
        if (!linearIssue) return null;
        return mergeSidecar(linearIssue, sidecarRow);
      }
      // Fallback: ask Linear directly (issue created in Linear without going through Paperclip)
      const linearIssue = await adapter.getIssueByIdentifier(identifier);
      if (!linearIssue) return null;
      const sidecar = await getSidecarByLinearId(linearIssue.externalIssueRef);
      return mergeSidecar(linearIssue, sidecar);
    },

    async list(opts: ListOpts): Promise<LinearBackedIssue[]> {
      const limit = opts.limit ?? 50;

      if (opts.assigneeAgentId !== undefined) {
        // Filter by agent: query sidecar for assigned linearIssueIds, then fetch from Linear
        const sidecars = await db
          .select()
          .from(issuesTable)
          .where(
            opts.assigneeAgentId === null
              ? isNull(issuesTable.assigneeAgentId)
              : eq(issuesTable.assigneeAgentId, opts.assigneeAgentId),
          )
          .limit(limit);

        // N round-trips to Linear; optimize later via listIssues(assigneeExternalRef) when agent's Linear user ref is known
        const linearIssues = await Promise.all(
          sidecars
            .filter((s) => s.linearIssueId)
            .map((s) => adapter.getIssue(s.linearIssueId!)),
        );

        return linearIssues
          .filter((i): i is Issue => i !== null)
          .map((linearIssue) => {
            const sidecar =
              sidecars.find((s) => s.linearIssueId === linearIssue.externalIssueRef) ?? null;
            return mergeSidecar(linearIssue, sidecar);
          });
      }

      // No agent filter: fetch from Linear adapter
      const linearIssues = await adapter.listIssues({ externalTeamRef, limit });
      return Promise.all(
        linearIssues.map(async (linearIssue) => {
          const sidecar = await getSidecarByLinearId(linearIssue.externalIssueRef);
          return mergeSidecar(linearIssue, sidecar);
        }),
      );
    },

    async update(id: string, args: UpdateArgs): Promise<LinearBackedIssue | null> {
      const sidecar = await getSidecarById(id);
      if (!sidecar?.linearIssueId) return null;

      // Core Linear fields
      const hasLinearUpdate =
        args.title !== undefined ||
        args.description !== undefined ||
        args.stateExternalRef !== undefined ||
        args.priority !== undefined;

      if (hasLinearUpdate) {
        await adapter.updateIssue({
          externalIssueRef: sidecar.linearIssueId,
          title: args.title,
          description: args.description,
          stateExternalRef: args.stateExternalRef,
          priority: args.priority,
          author: systemAuthor(adapter.backendKey, systemRef),
        });
      }

      // Agent-only sidecar fields
      const sidecarPatch: Partial<typeof issuesTable.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (args.assigneeAgentId !== undefined) sidecarPatch.assigneeAgentId = args.assigneeAgentId;
      if (args.assigneeUserId !== undefined) sidecarPatch.assigneeUserId = args.assigneeUserId;
      if (args.executionPolicy !== undefined) sidecarPatch.executionPolicy = args.executionPolicy;
      if (args.executionState !== undefined) sidecarPatch.executionState = args.executionState;
      if (args.hiddenAt !== undefined) sidecarPatch.hiddenAt = args.hiddenAt;
      if (args.startedAt !== undefined) sidecarPatch.startedAt = args.startedAt;
      if (args.completedAt !== undefined) sidecarPatch.completedAt = args.completedAt;
      if (args.cancelledAt !== undefined) sidecarPatch.cancelledAt = args.cancelledAt;

      await db.update(issuesTable).set(sidecarPatch).where(eq(issuesTable.id, id));

      return this.getById(id);
    },

    async remove(id: string): Promise<void> {
      const sidecar = await getSidecarById(id);
      if (!sidecar) throw new Error(`remove: no sidecar for id ${id}`);
      if (!sidecar.linearIssueId) throw new Error(`remove: sidecar ${id} has no linearIssueId`);
      await adapter.archiveIssue(sidecar.linearIssueId);
      await db.delete(issuesTable).where(eq(issuesTable.id, id));
    },

    async getComments(id: string) {
      const sidecar = await getSidecarById(id);
      if (!sidecar?.linearIssueId) return [];
      return adapter.getComments(sidecar.linearIssueId);
    },
  };
}
