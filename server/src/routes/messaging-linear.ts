import express, { type Router, type Request, type Response } from "express";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  agents as agentsTable,
  companies,
  messagingCompanyConfig,
  messagingWorkspaceInstall,
  type Db,
} from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound, unprocessable } from "../errors.js";
import {
  buildAppAuthorizeUrl,
  exchangeAppCode,
  readLinearEnv,
  storeWebhookSecret,
  storeWorkspaceAppToken,
} from "../messaging/adapters/linear/oauth-app.js";
import {
  buildUserAuthorizeUrl,
  completeUserOAuth,
} from "../messaging/adapters/linear/oauth-user.js";
import { createLinearClient } from "../messaging/adapters/linear/client.js";
import {
  resolveWorkflowStateMap,
  type LinearWorkflowState,
} from "../messaging/adapters/linear/workflow-state-map.js";
import { verifyLinearSignature } from "../messaging/adapters/linear/webhook.js";
import {
  invalidateMessagingContext,
  isMessagingInitialized,
  resolveMessagingContext,
} from "../messaging/index.js";
import { logger } from "../middleware/logger.js";

const STATE_TTL_SEC = 10 * 60;

function mintStateToken(secret: string, claims: Record<string, unknown>): string {
  const payload = {
    ...claims,
    nonce: randomBytes(16).toString("hex"),
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SEC,
  };
  const json = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(json).digest("hex");
  return `${json}.${sig}`;
}

function verifyStateToken(
  token: string,
  secret: string,
): Record<string, unknown> | null {
  const [json, sig] = token.split(".");
  if (!json || !sig) return null;
  const expected = createHmac("sha256", secret).update(json).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const decoded = JSON.parse(
      Buffer.from(json, "base64url").toString("utf8"),
    ) as { exp?: number };
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function messagingLinearRoutes(db: Db): Router {
  const router = express.Router();

  // --- Workspace (app) OAuth flow -----------------------------------------

  router.get("/linear/oauth/app/start", async (req: Request, res: Response) => {
    assertBoard(req);
    const env = readLinearEnv();
    if (!env) {
      throw unprocessable(
        "Linear OAuth app is not configured (LINEAR_APP_CLIENT_ID missing)",
      );
    }
    const companyId = (req.query.companyId as string | undefined) ?? "";
    if (!companyId) throw badRequest("companyId query param required");
    assertCompanyAccess(req, companyId);
    // Only accept relative returnUrl to prevent open redirects; silently ignore absolute URLs.
    const rawReturnUrl = req.query.returnUrl as string | undefined;
    const returnUrl = rawReturnUrl?.startsWith("/") ? rawReturnUrl : undefined;
    const stateToken = mintStateToken(env.clientSecret, {
      kind: "linear_app_install",
      companyId,
      ...(returnUrl ? { returnUrl } : {}),
    });
    res.redirect(buildAppAuthorizeUrl(env, { companyId, stateToken }));
  });

  router.get(
    "/linear/oauth/app/callback",
    async (req: Request, res: Response) => {
      const env = readLinearEnv();
      if (!env) throw unprocessable("Linear OAuth app is not configured");
      const code = (req.query.code as string | undefined) ?? "";
      const stateToken = (req.query.state as string | undefined) ?? "";
      if (!code || !stateToken) throw badRequest("missing code or state");
      const claims = verifyStateToken(stateToken, env.clientSecret);
      if (!claims || claims.kind !== "linear_app_install") {
        throw badRequest("invalid state");
      }
      const companyId = typeof claims.companyId === "string" ? claims.companyId : "";
      if (!companyId) throw badRequest("invalid state payload");

      const redirectUri = `${env.redirectBaseUrl.replace(/\/$/, "")}/api/messaging/linear/oauth/app/callback`;
      const exch = await exchangeAppCode({ env, code, redirectUri });

      const appTokenSecretId = await storeWorkspaceAppToken(
        db,
        companyId,
        exch.access_token,
      );

      const [companyRow] = await db
        .select({ issuePrefix: companies.issuePrefix, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!companyRow) throw notFound("Company not found");

      const linearClient = createLinearClient({ token: exch.access_token });

      // Resolve or create the team whose key matches companies.issue_prefix.
      const teamsRes = await linearClient.request<{
        teams: { nodes: Array<{ id: string; key: string; name: string }> };
      }>(`query Teams { teams { nodes { id key name } } }`);
      let team = teamsRes.teams.nodes.find(
        (t) => t.key === companyRow.issuePrefix,
      );
      if (!team) {
        try {
          const created = await linearClient.request<{
            teamCreate: {
              success: boolean;
              team: { id: string; key: string; name: string };
            };
          }>(
            `mutation TeamCreate($input: TeamCreateInput!) {
               teamCreate(input: $input) { success team { id key name } }
             }`,
            { input: { name: companyRow.name, key: companyRow.issuePrefix } },
          );
          if (!created.teamCreate.success) {
            throw unprocessable(
              `Linear teamCreate failed; team key ${companyRow.issuePrefix} may conflict. Create the team manually in Linear and rename its key to match.`,
            );
          }
          team = created.teamCreate.team;
        } catch (err) {
          logger.warn(
            { err, companyId, issuePrefix: companyRow.issuePrefix },
            "linear: teamCreate failed; falling back to first available team",
          );
          team = teamsRes.teams.nodes[0];
          if (!team) {
            throw unprocessable(
              "Linear workspace has no teams; create one first.",
            );
          }
        }
      }

      // Fetch the OAuth app's viewer (actor id) for bot_user_ref.
      const viewerRes = await linearClient.request<{
        viewer: { id: string; name: string };
      }>(`query Viewer { viewer { id name } }`);
      const actorId = viewerRes.viewer.id;

      // Resolve the team's workflow state map.
      const statesRes = await linearClient.request<{
        team: {
          states: {
            nodes: Array<{ id: string; name: string; type: string }>;
          };
        } | null;
      }>(
        `query States($teamId: String!) {
           team(id: $teamId) { states { nodes { id name type } } }
         }`,
        { teamId: team.id },
      );
      const workflowMap = resolveWorkflowStateMap(
        (statesRes.team?.states.nodes ?? []) as LinearWorkflowState[],
      );

      // Store the webhook signing secret. Linear registers the webhook at
      // app-creation time in the developer UI; the signing secret is a
      // single global value supplied via LINEAR_WEBHOOK_SECRET env var.
      const webhookSecretRaw = process.env.LINEAR_WEBHOOK_SECRET;
      if (!webhookSecretRaw) {
        throw unprocessable(
          "LINEAR_WEBHOOK_SECRET env var must be set for Linear webhook verification",
        );
      }
      const webhookSecretId = await storeWebhookSecret(
        db,
        companyId,
        webhookSecretRaw,
      );

      const [existingInstall] = await db
        .select()
        .from(messagingWorkspaceInstall)
        .where(
          and(
            eq(messagingWorkspaceInstall.companyId, companyId),
            eq(messagingWorkspaceInstall.backend, "linear"),
          ),
        )
        .limit(1);

      const metadata = {
        linearTeamId: team.id,
        linearTeamKey: team.key,
        linearWorkflowStateMap: workflowMap,
      };

      if (existingInstall) {
        await db
          .update(messagingWorkspaceInstall)
          .set({
            externalWorkspaceRef:
              exch.organization_id ?? existingInstall.externalWorkspaceRef,
            botUserRef: actorId,
            botTokenSecretId: appTokenSecretId,
            signingSecretId: webhookSecretId,
            state: "active",
            metadata,
            updatedAt: new Date(),
          })
          .where(eq(messagingWorkspaceInstall.id, existingInstall.id));
      } else {
        await db.insert(messagingWorkspaceInstall).values({
          companyId,
          backend: "linear",
          externalWorkspaceRef: exch.organization_id ?? "unknown-org",
          workspaceName: null,
          botUserRef: actorId,
          botTokenSecretId: appTokenSecretId,
          signingSecretId: webhookSecretId,
          installedByUserId:
            req.actor.type === "board" ? req.actor.userId ?? null : null,
          state: "active",
          metadata,
        });
      }

      await db
        .insert(messagingCompanyConfig)
        .values({ companyId, activeBackend: "linear" })
        .onConflictDoUpdate({
          target: messagingCompanyConfig.companyId,
          set: { activeBackend: "linear", updatedAt: new Date() },
        });

      invalidateMessagingContext(companyId);

      const returnUrl =
        typeof claims.returnUrl === "string" &&
        claims.returnUrl.startsWith("/")
          ? claims.returnUrl
          : null;
      if (returnUrl) {
        res.redirect(returnUrl);
        return;
      }

      const prefix = companyRow.issuePrefix;
      res.redirect(
        `/${encodeURIComponent(prefix)}/company/settings/messaging?linear_installed=1`,
      );
    },
  );

  // --- Per-agent user OAuth flow ------------------------------------------

  router.get(
    "/linear/oauth/user/start",
    async (req: Request, res: Response) => {
      assertBoard(req);
      const env = readLinearEnv();
      if (!env) throw unprocessable("Linear OAuth app is not configured");
      const agentId = (req.query.agentId as string | undefined) ?? "";
      if (!agentId) throw badRequest("agentId query param required");

      const [agent] = await db
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.id, agentId))
        .limit(1);
      if (!agent) throw notFound("agent not found");
      assertCompanyAccess(req, agent.companyId);

      const stateToken = mintStateToken(env.clientSecret, {
        kind: "linear_user_oauth",
        companyId: agent.companyId,
        agentId,
      });
      res.redirect(buildUserAuthorizeUrl(env, stateToken));
    },
  );

  router.get(
    "/linear/oauth/user/callback",
    async (req: Request, res: Response) => {
      const env = readLinearEnv();
      if (!env) throw unprocessable("Linear OAuth app is not configured");
      const code = (req.query.code as string | undefined) ?? "";
      const stateToken = (req.query.state as string | undefined) ?? "";
      if (!code || !stateToken) throw badRequest("missing code or state");
      const claims = verifyStateToken(stateToken, env.clientSecret);
      if (!claims || claims.kind !== "linear_user_oauth") {
        throw badRequest("invalid state");
      }
      const companyId = typeof claims.companyId === "string" ? claims.companyId : "";
      const agentId = typeof claims.agentId === "string" ? claims.agentId : "";
      if (!companyId || !agentId) throw badRequest("invalid state payload");

      await completeUserOAuth({
        db,
        env,
        code,
        companyId,
        agentId,
        actorUserId:
          req.actor.type === "board" ? req.actor.userId ?? null : null,
      });

      const [companyRow] = await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      const prefix = companyRow?.issuePrefix ?? "";
      res.redirect(
        prefix
          ? `/${encodeURIComponent(prefix)}/company/settings/messaging?linear_linked=${encodeURIComponent(agentId)}`
          : `/company/settings/messaging?linear_linked=${encodeURIComponent(agentId)}`,
      );
    },
  );

  // --- Webhook -------------------------------------------------------------

  router.post("/linear/events", async (req: Request, res: Response) => {
    // Ack fast per Linear's 10s delivery budget.
    const stashedRaw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const rawBody = stashedRaw
      ? stashedRaw.toString("utf-8")
      : JSON.stringify(req.body ?? {});
    const signatureHeader = req.header("linear-signature") ?? "";

    const body = (req.body ?? {}) as Record<string, unknown>;
    const organizationId =
      typeof body.organizationId === "string" ? body.organizationId : null;

    const secret = process.env.LINEAR_WEBHOOK_SECRET;
    if (!secret) {
      logger.warn("linear events: LINEAR_WEBHOOK_SECRET not set; rejecting");
      res.status(500).json({ error: "webhook secret not configured" });
      return;
    }

    const ok = verifyLinearSignature({
      signature: signatureHeader,
      rawBody,
      secret,
    });
    if (!ok) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    // Ack before processing.
    res.status(200).json({});

    if (!organizationId) return;
    if (!isMessagingInitialized()) return;

    // Resolve the install by organizationId to find the company.
    const [install] = await db
      .select()
      .from(messagingWorkspaceInstall)
      .where(
        and(
          eq(messagingWorkspaceInstall.backend, "linear"),
          eq(messagingWorkspaceInstall.externalWorkspaceRef, organizationId),
        ),
      )
      .limit(1);
    if (!install) {
      logger.warn(
        { organizationId },
        "linear events: no matching workspace install",
      );
      return;
    }

    void (async () => {
      try {
        const ctx = await resolveMessagingContext(install.companyId);
        if (ctx.status !== "ready" || ctx.backend !== "linear") return;
        const normalized = ctx.adapter.normalizeEvent(body);
        if (!normalized) return;
        await ctx.events.handle(normalized);
      } catch (err) {
        logger.warn(
          { err, companyId: install.companyId },
          "linear events: processor failed",
        );
      }
    })();

    // Silence the unused-var warning for sql which is occasionally used in
    // metadata upserts above (Drizzle re-exports it).
    void sql;
  });

  return router;
}
