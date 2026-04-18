import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  agents as agentsTable,
  issues as issuesTable,
  messagingChannels,
  messagingCompanyConfig,
  messagingIdentities,
  messagingMessageRefs,
  messagingThreads,
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
}

const BACKEND = "slack" as const;

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

      let readiness: MessagingStatusReadiness;
      if (!activeBackend) {
        readiness = "disabled";
      } else if (!installed) {
        readiness = "not_installed";
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
        .select({ id: issuesTable.id, companyId: issuesTable.companyId })
        .from(issuesTable)
        .where(eq(issuesTable.id, issueId))
        .limit(1);
      if (!issue) throw notFound("Issue not found");
      assertCompanyAccess(req, issue.companyId);

      // Resolve the company's messaging context so operators can see what
      // the runtime would pick for this issue's company — disabled,
      // not_installed, or ready (with backend + workspace id).
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

      const [thread] = await db
        .select({
          id: messagingThreads.id,
          issueId: messagingThreads.issueId,
          channelId: messagingThreads.channelId,
          backend: messagingThreads.backend,
          externalThreadRef: messagingThreads.externalThreadRef,
          parentMessageRef: messagingThreads.parentMessageRef,
          state: messagingThreads.state,
          createdAt: messagingThreads.createdAt,
        })
        .from(messagingThreads)
        .where(eq(messagingThreads.issueId, issueId))
        .limit(1);

      if (!thread) {
        res.json({
          context: contextOut,
          thread: null,
          channel: null,
          recentMessages: [],
        });
        return;
      }

      const [channel] = await db
        .select({
          id: messagingChannels.id,
          workspaceInstallId: messagingChannels.workspaceInstallId,
          externalChannelRef: messagingChannels.externalChannelRef,
          externalChannelName: messagingChannels.externalChannelName,
          purpose: messagingChannels.purpose,
          state: messagingChannels.state,
        })
        .from(messagingChannels)
        .where(eq(messagingChannels.id, thread.channelId))
        .limit(1);

      const recentMessagesRaw = await db
        .select({
          id: messagingMessageRefs.id,
          externalMessageRef: messagingMessageRefs.externalMessageRef,
          authorAgentId: messagingMessageRefs.authorAgentId,
          authorUserId: messagingMessageRefs.authorUserId,
          createdByRunId: messagingMessageRefs.createdByRunId,
          firstSeenAt: messagingMessageRefs.firstSeenAt,
          editedAt: messagingMessageRefs.editedAt,
          editCount: messagingMessageRefs.editCount,
          deletedAt: messagingMessageRefs.deletedAt,
          suppressedForWake: messagingMessageRefs.suppressedForWake,
          metadata: messagingMessageRefs.metadata,
        })
        .from(messagingMessageRefs)
        .where(eq(messagingMessageRefs.threadId, thread.id))
        .orderBy(desc(messagingMessageRefs.firstSeenAt))
        .limit(10);

      const recentMessages = recentMessagesRaw.map((row) => {
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
        thread,
        channel: channel ?? null,
        recentMessages,
      });
    },
  );

  return router;
}
