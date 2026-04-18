import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import {
  agents as agentsTable,
  messagingIdentities,
  messagingWorkspaceInstall,
  type Db,
} from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";

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

  return router;
}
