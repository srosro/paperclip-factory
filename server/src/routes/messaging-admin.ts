import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  agents as agentsTable,
  issues as issuesTable,
  messagingChannels,
  messagingIdentities,
  messagingMessageRefs,
  messagingThreads,
  messagingWorkspaceInstall,
  type Db,
} from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

export interface MessagingAgentIdentityStatus {
  agentId: string;
  agentName: string;
  state: "active" | "pending_auth" | "revoked";
}

export interface MessagingStatusResponse {
  installed: boolean;
  workspaceName: string | null;
  workspaceRef: string | null;
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

      const installed = Boolean(install) && install?.state === "active";

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

      const response: MessagingStatusResponse = {
        installed,
        workspaceName: install?.workspaceName ?? null,
        workspaceRef: install?.externalWorkspaceRef ?? null,
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
        res.json({ thread: null, channel: null, recentMessages: [] });
        return;
      }

      const [channel] = await db
        .select({
          id: messagingChannels.id,
          externalChannelRef: messagingChannels.externalChannelRef,
          externalChannelName: messagingChannels.externalChannelName,
          state: messagingChannels.state,
        })
        .from(messagingChannels)
        .where(eq(messagingChannels.id, thread.channelId))
        .limit(1);

      const recentMessages = await db
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
        })
        .from(messagingMessageRefs)
        .where(eq(messagingMessageRefs.threadId, thread.id))
        .orderBy(desc(messagingMessageRefs.firstSeenAt))
        .limit(10);

      res.json({
        thread,
        channel: channel ?? null,
        recentMessages,
      });
    },
  );

  return router;
}
