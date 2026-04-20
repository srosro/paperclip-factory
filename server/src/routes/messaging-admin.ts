import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  agents as agentsTable,
  issueCommentRefs,
  issues as issuesTable,
  messagingCompanyConfig,
  messagingIdentities,
  messagingWorkspaceInstall,
  type Db,
} from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";
import { resolveMessagingContext } from "../messaging/index.js";

export interface MessagingAgentIdentityStatus {
  agentId: string;
  agentName: string;
  state: "active" | "pending_auth" | "revoked";
}

export type MessagingStatusReadiness =
  | "disabled"
  | "not_installed"
  | "workflow_mapping_incomplete"
  | "agent_identities_incomplete"
  | "ready";

export interface MessagingStatusResponse {
  installed: boolean;
  readiness: MessagingStatusReadiness;
  activeBackend: string | null;
  workspaceName: string | null;
  workspaceRef: string | null;
  workspaceInstallId: string | null;
  agentIdentities: MessagingAgentIdentityStatus[];
  missingWorkflowStates?: string[];
}

const BACKEND = "linear" as const;

function normalizeIdentityState(
  state: string | null | undefined,
): MessagingAgentIdentityStatus["state"] {
  if (state === "active" || state === "revoked") return state;
  return "pending_auth";
}

export function messagingAdminRoutes(db: Db): Router {
  const router = Router();

  router.get(
    "/companies/:companyId/messaging/status",
    async (req: Request, res: Response) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const [install] = await db
        .select({
          id: messagingWorkspaceInstall.id,
          workspaceName: messagingWorkspaceInstall.workspaceName,
          externalWorkspaceRef: messagingWorkspaceInstall.externalWorkspaceRef,
          state: messagingWorkspaceInstall.state,
          metadata: messagingWorkspaceInstall.metadata,
        })
        .from(messagingWorkspaceInstall)
        .where(
          and(
            eq(messagingWorkspaceInstall.backend, BACKEND),
            eq(messagingWorkspaceInstall.companyId, companyId),
          ),
        )
        .limit(1);

      const [cfg] = await db
        .select({ activeBackend: messagingCompanyConfig.activeBackend })
        .from(messagingCompanyConfig)
        .where(eq(messagingCompanyConfig.companyId, companyId))
        .limit(1);

      const installed = Boolean(install) && install?.state === "active";
      const activeBackend = cfg?.activeBackend ?? null;

      const agentRows = await db
        .select({
          agentId: agentsTable.id,
          agentName: agentsTable.name,
          status: agentsTable.status,
          identityState: messagingIdentities.state,
        })
        .from(agentsTable)
        .leftJoin(
          messagingIdentities,
          and(
            eq(messagingIdentities.agentId, agentsTable.id),
            eq(messagingIdentities.backend, BACKEND),
          ),
        )
        .where(eq(agentsTable.companyId, companyId));

      const agentIdentities: MessagingAgentIdentityStatus[] = agentRows
        .filter((row) => row.status !== "terminated")
        .map((row) => ({
          agentId: row.agentId,
          agentName: row.agentName,
          state: normalizeIdentityState(row.identityState),
        }))
        .sort((a, b) => a.agentName.localeCompare(b.agentName));

      const workflowMap = install?.metadata
        ? ((install.metadata as Record<string, unknown>)
            .linearWorkflowStateMap as
            | { kind: "complete" | "incomplete"; missing?: string[] }
            | undefined)
        : undefined;
      const missingWorkflowStates =
        workflowMap?.kind === "incomplete" ? workflowMap.missing ?? [] : [];

      let readiness: MessagingStatusReadiness;
      if (!activeBackend) {
        readiness = "disabled";
      } else if (!installed) {
        readiness = "not_installed";
      } else if (missingWorkflowStates.length > 0) {
        readiness = "workflow_mapping_incomplete";
      } else {
        const hasIncomplete = agentIdentities.some(
          (a) => a.state !== "active",
        );
        readiness = hasIncomplete ? "agent_identities_incomplete" : "ready";
      }

      const response: MessagingStatusResponse = {
        installed,
        readiness,
        activeBackend,
        workspaceName: install?.workspaceName ?? null,
        workspaceRef: install?.externalWorkspaceRef ?? null,
        workspaceInstallId: install?.id ?? null,
        agentIdentities,
        ...(missingWorkflowStates.length > 0
          ? { missingWorkflowStates }
          : {}),
      };
      res.json(response);
    },
  );

  router.get(
    "/messaging/diagnose/:issueId",
    async (req: Request, res: Response) => {
      assertBoard(req);
      const issueId = req.params.issueId as string;

      const [issue] = await db
        .select({
          id: issuesTable.id,
          companyId: issuesTable.companyId,
          identifier: issuesTable.identifier,
          title: issuesTable.title,
          status: issuesTable.status,
          linearIssueId: issuesTable.linearIssueId,
          linearIssueIdentifier: issuesTable.linearIssueIdentifier,
        })
        .from(issuesTable)
        .where(eq(issuesTable.id, issueId))
        .limit(1);
      if (!issue) throw notFound("Issue not found");
      assertCompanyAccess(req, issue.companyId);

      const ctx = await resolveMessagingContext(issue.companyId);
      const contextOut =
        ctx.status === "ready"
          ? {
              status: ctx.status,
              backend: ctx.backend,
              workspaceInstallId: ctx.workspaceInstall?.id ?? null,
              externalWorkspaceRef:
                ctx.workspaceInstall?.externalWorkspaceRef ?? null,
            }
          : ctx.status === "not_installed"
            ? { status: ctx.status, backend: ctx.backend }
            : { status: ctx.status };

      const recentCommentsRaw = await db
        .select({
          id: issueCommentRefs.id,
          externalMessageRef: issueCommentRefs.externalMessageRef,
          authorAgentId: issueCommentRefs.authorAgentId,
          authorUserId: issueCommentRefs.authorUserId,
          createdByRunId: issueCommentRefs.createdByRunId,
          firstSeenAt: issueCommentRefs.firstSeenAt,
          editedAt: issueCommentRefs.editedAt,
          editCount: issueCommentRefs.editCount,
          deletedAt: issueCommentRefs.deletedAt,
          suppressedForWake: issueCommentRefs.suppressedForWake,
          metadata: issueCommentRefs.metadata,
        })
        .from(issueCommentRefs)
        .where(eq(issueCommentRefs.issueId, issue.id))
        .orderBy(desc(issueCommentRefs.firstSeenAt))
        .limit(10);

      const recentComments = recentCommentsRaw.map((row) => {
        const metadata = (row.metadata ?? {}) as Record<string, unknown>;
        const sideEffectsDispatchedAt =
          typeof metadata.sideEffectsDispatchedAt === "string"
            ? metadata.sideEffectsDispatchedAt
            : null;
        const cancelledAt =
          typeof metadata.cancelledAt === "string" ? metadata.cancelledAt : null;
        return {
          id: row.id,
          externalMessageRef: row.externalMessageRef,
          authorAgentId: row.authorAgentId,
          authorUserId: row.authorUserId,
          createdByRunId: row.createdByRunId,
          firstSeenAt: row.firstSeenAt,
          editedAt: row.editedAt,
          editCount: row.editCount,
          deletedAt: row.deletedAt,
          suppressedForWake: row.suppressedForWake,
          sideEffectsDispatchedAt,
          cancelledAt,
        };
      });

      res.json({
        context: contextOut,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          linearIssueId: issue.linearIssueId,
          linearIssueIdentifier: issue.linearIssueIdentifier,
        },
        recentComments,
      });
    },
  );

  return router;
}
