import express, { type Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../messaging/router.js";
import {
  agents as agentsTable,
  messagingIdentities,
  messagingWorkspaceInstall,
  companySecrets,
  companies as companiesTable,
} from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { verifySlackSignature } from "../messaging/adapters/slack/signing.js";
import {
  storeBotToken,
  storeSigningSecret,
  storeUserToken,
  getSigningSecretForCompany,
} from "../messaging/adapters/slack/token-store.js";
import { messagingRegistry } from "../messaging/registry.js";
import { getEventsProcessor, isMessagingInitialized } from "../messaging/index.js";
import { logger } from "../middleware/logger.js";

const BOT_SCOPES = [
  "channels:read",
  "channels:manage",
  "channels:history",
  "groups:history",
  "im:history",
  "chat:write",
  "users:read",
  "users:read.email",
  "reactions:read",
  "reactions:write",
].join(",");

const USER_SCOPES = [
  "chat:write",
  "im:history",
  "im:write",
  "groups:history",
  "users:read",
  "users.profile:read",
  "reactions:write",
].join(",");

const STATE_TTL_SEC = 10 * 60; // 10 minutes

interface SlackEnv {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  redirectBaseUrl: string;
}

function readSlackEnv(): SlackEnv | null {
  const clientId = process.env.SLACK_APP_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.SLACK_APP_CLIENT_SECRET?.trim() ?? "";
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim() ?? "";
  const redirectBaseUrl = process.env.SLACK_OAUTH_REDIRECT_BASE_URL?.trim() ?? "";
  if (!clientId || !clientSecret || !signingSecret || !redirectBaseUrl) return null;
  return { clientId, clientSecret, signingSecret, redirectBaseUrl };
}

function notConfiguredResponse(res: Response): void {
  res.status(503).json({
    error: "Slack app credentials not configured",
    code: "messaging_slack_not_configured",
  });
}

// -- signed state tokens ----------------------------------------------------
// Format: base64url(JSON payload) + "." + hex hmac(signingSecret, payload)

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function signState(payload: Record<string, unknown>, secret: string): string {
  const json = JSON.stringify(payload);
  const body = b64urlEncode(Buffer.from(json, "utf8"));
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${sig}`;
}

function verifyState(token: string, secret: string): Record<string, unknown> | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    const raw = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (!raw || typeof raw !== "object") return null;
    const parsed = raw as Record<string, unknown>;
    const exp = typeof parsed.exp === "number" ? parsed.exp : 0;
    if (exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface SlackOAuthV2Response {
  ok: boolean;
  error?: string;
  access_token?: string; // bot token
  bot_user_id?: string;
  team?: { id?: string; name?: string };
  authed_user?: { id?: string; access_token?: string };
}

async function exchangeSlackCode(args: {
  env: SlackEnv;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<SlackOAuthV2Response> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: args.env.clientId,
    client_secret: args.env.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  const res = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return (await res.json()) as SlackOAuthV2Response;
}

export interface SlackRoutesOpts {
  /** Override Slack OAuth code-exchange for tests. */
  exchangeCode?: typeof exchangeSlackCode;
  /** Override env lookup for tests. */
  readEnv?: () => SlackEnv | null;
  /** Inject current UTC epoch seconds for deterministic tests. */
  nowSec?: () => number;
}

export function messagingSlackRoutes(db: Db, opts: SlackRoutesOpts = {}): Router {
  const router = express.Router();
  const readEnv = opts.readEnv ?? readSlackEnv;
  const exchange = opts.exchangeCode ?? exchangeSlackCode;
  const now = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));

  // ---------- Bot install OAuth (workspace admin) ----------
  router.get("/oauth/bot/start", async (req: Request, res: Response) => {
    assertBoard(req);
    const env = readEnv();
    if (!env) return notConfiguredResponse(res);

    const companyId = (req.query.companyId as string | undefined) ?? "";
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const state = signState(
      {
        kind: "slack_bot_install",
        companyId,
        nonce: randomBytes(16).toString("hex"),
        exp: now() + STATE_TTL_SEC,
      },
      env.signingSecret,
    );

    const redirectUri = `${env.redirectBaseUrl.replace(/\/$/, "")}/api/messaging/slack/oauth/bot/callback`;
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.searchParams.set("client_id", env.clientId);
    authorize.searchParams.set("scope", BOT_SCOPES);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state);
    res.redirect(authorize.toString());
  });

  router.get("/oauth/bot/callback", async (req: Request, res: Response) => {
    const env = readEnv();
    if (!env) return notConfiguredResponse(res);

    const code = (req.query.code as string | undefined) ?? "";
    const stateToken = (req.query.state as string | undefined) ?? "";
    if (!code || !stateToken) throw badRequest("missing code or state");

    const claims = verifyState(stateToken, env.signingSecret);
    if (!claims || claims.kind !== "slack_bot_install") {
      throw badRequest("invalid state");
    }
    const companyId = typeof claims.companyId === "string" ? claims.companyId : "";
    if (!companyId) throw badRequest("invalid state payload");

    // Confirm company exists before doing any FK-touching work.
    const [company] = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);
    if (!company) throw notFound("company not found");

    const redirectUri = `${env.redirectBaseUrl.replace(/\/$/, "")}/api/messaging/slack/oauth/bot/callback`;
    const exch = await exchange({ env, code, redirectUri });
    if (!exch.ok || !exch.access_token || !exch.team?.id || !exch.bot_user_id) {
      throw unprocessable(`slack oauth failed: ${exch.error ?? "unknown_error"}`);
    }

    const botTokenSecretId = await storeBotToken(db, {
      companyId,
      value: exch.access_token,
      actorUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
    const signingSecretId = await storeSigningSecret(db, {
      companyId,
      value: env.signingSecret,
      actorUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });

    // Upsert install. Unique by (companyId, backend, externalWorkspaceRef) is
    // not schema-enforced; we resolve by (companyId, backend) — one install
    // per company for Phase 1.
    const [existing] = await db
      .select()
      .from(messagingWorkspaceInstall)
      .where(
        and(
          eq(messagingWorkspaceInstall.companyId, companyId),
          eq(messagingWorkspaceInstall.backend, "slack"),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(messagingWorkspaceInstall)
        .set({
          externalWorkspaceRef: exch.team.id,
          workspaceName: exch.team.name ?? null,
          botUserRef: exch.bot_user_id,
          botTokenSecretId,
          signingSecretId,
          state: "active",
          updatedAt: new Date(),
        })
        .where(eq(messagingWorkspaceInstall.id, existing.id));
    } else {
      await db.insert(messagingWorkspaceInstall).values({
        companyId,
        backend: "slack",
        externalWorkspaceRef: exch.team.id,
        workspaceName: exch.team.name ?? null,
        botUserRef: exch.bot_user_id,
        botTokenSecretId,
        signingSecretId,
        installedByUserId:
          req.actor.type === "board" ? req.actor.userId ?? null : null,
        state: "active",
      });
    }

    // Redirect back into the UI.
    res.redirect("/settings/messaging?installed=1");
  });

  // ---------- Per-agent user OAuth ----------
  router.get("/oauth/user/start", async (req: Request, res: Response) => {
    assertBoard(req);
    const env = readEnv();
    if (!env) return notConfiguredResponse(res);

    const agentId = (req.query.agentId as string | undefined) ?? "";
    if (!agentId) throw badRequest("agentId is required");

    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    if (!agent) throw notFound("agent not found");
    assertCompanyAccess(req, agent.companyId);

    const state = signState(
      {
        kind: "slack_user_oauth",
        companyId: agent.companyId,
        agentId,
        nonce: randomBytes(16).toString("hex"),
        exp: now() + STATE_TTL_SEC,
      },
      env.signingSecret,
    );

    const redirectUri = `${env.redirectBaseUrl.replace(/\/$/, "")}/api/messaging/slack/oauth/user/callback`;
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.searchParams.set("client_id", env.clientId);
    authorize.searchParams.set("user_scope", USER_SCOPES);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state);
    res.redirect(authorize.toString());
  });

  router.get("/oauth/user/callback", async (req: Request, res: Response) => {
    const env = readEnv();
    if (!env) return notConfiguredResponse(res);

    const code = (req.query.code as string | undefined) ?? "";
    const stateToken = (req.query.state as string | undefined) ?? "";
    if (!code || !stateToken) throw badRequest("missing code or state");

    const claims = verifyState(stateToken, env.signingSecret);
    if (!claims || claims.kind !== "slack_user_oauth") {
      throw badRequest("invalid state");
    }
    const companyId = typeof claims.companyId === "string" ? claims.companyId : "";
    const agentId = typeof claims.agentId === "string" ? claims.agentId : "";
    if (!companyId || !agentId) throw badRequest("invalid state payload");

    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    if (!agent || agent.companyId !== companyId) throw notFound("agent not found");

    const redirectUri = `${env.redirectBaseUrl.replace(/\/$/, "")}/api/messaging/slack/oauth/user/callback`;
    const exch = await exchange({ env, code, redirectUri });
    if (
      !exch.ok ||
      !exch.authed_user?.id ||
      !exch.authed_user.access_token
    ) {
      throw unprocessable(`slack oauth failed: ${exch.error ?? "unknown_error"}`);
    }

    const externalUserRef = exch.authed_user.id;

    // Reject if another identity in this company already holds this slack
    // user id, attached to a different principal.
    const [collision] = await db
      .select()
      .from(messagingIdentities)
      .where(
        and(
          eq(messagingIdentities.backend, "slack"),
          eq(messagingIdentities.companyId, companyId),
          eq(messagingIdentities.externalUserRef, externalUserRef),
        ),
      )
      .limit(1);
    if (collision && collision.agentId && collision.agentId !== agentId) {
      throw conflict("slack user id already bound to another agent");
    }

    const userTokenSecretId = await storeUserToken(db, {
      companyId,
      agentId,
      value: exch.authed_user.access_token,
      actorUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });

    const [existingIdentity] = await db
      .select()
      .from(messagingIdentities)
      .where(
        and(
          eq(messagingIdentities.backend, "slack"),
          eq(messagingIdentities.companyId, companyId),
          eq(messagingIdentities.agentId, agentId),
        ),
      )
      .limit(1);

    if (existingIdentity) {
      await db
        .update(messagingIdentities)
        .set({
          externalUserRef,
          authBlobSecretId: userTokenSecretId,
          state: "active",
          lastRefreshedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(messagingIdentities.id, existingIdentity.id));
    } else {
      await db.insert(messagingIdentities).values({
        companyId,
        agentId,
        backend: "slack",
        externalUserRef,
        authBlobSecretId: userTokenSecretId,
        state: "active",
        lastRefreshedAt: new Date(),
      });
    }

    res.redirect(`/companies/${companyId}/agents/${agentId}?slack_linked=1`);
  });

  // ---------- Events API webhook ----------
  router.post("/events", async (req: Request, res: Response) => {
    // URL verification short-circuit (Slack does sign these, but accepting
    // them unverified keeps initial app setup smooth; signature verification
    // below applies to all other event payloads).
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.type === "url_verification" && typeof body.challenge === "string") {
      res.json({ challenge: body.challenge });
      return;
    }

    const env = readEnv();
    const stashedRaw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const rawBody = stashedRaw ? stashedRaw.toString("utf-8") : "";
    const timestampHeader = req.header("x-slack-request-timestamp") ?? "";
    const signatureHeader = req.header("x-slack-signature") ?? "";

    // Locate the install by team_id to pick the correct signing secret.
    const teamId = typeof body.team_id === "string" ? body.team_id : null;
    let signingSecret: string | null = null;
    let companyId: string | null = null;

    if (teamId) {
      const [install] = await db
        .select()
        .from(messagingWorkspaceInstall)
        .where(
          and(
            eq(messagingWorkspaceInstall.backend, "slack"),
            eq(messagingWorkspaceInstall.externalWorkspaceRef, teamId),
          ),
        )
        .limit(1);
      if (install) {
        companyId = install.companyId;
        signingSecret = await getSigningSecretForCompany(db, install.companyId);
      }
    }
    // Fall back to env-level signing secret if no per-workspace one is stored.
    if (!signingSecret && env?.signingSecret) {
      signingSecret = env.signingSecret;
    }
    if (!signingSecret) {
      res.status(401).json({ error: "no signing secret available" });
      return;
    }

    const ok = verifySlackSignature({
      signingSecret,
      timestampHeader,
      signatureHeader,
      rawBody,
    });
    if (!ok) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    // Ack fast so Slack's 3s budget is met even with slow DB hops.
    res.status(200).json({});

    if (!isMessagingInitialized()) return;
    const adapter = messagingRegistry.get("slack");
    if (!adapter) return;

    const normalized = adapter.normalizeEvent(body);
    if (!normalized) return;

    void (async () => {
      try {
        const processor = getEventsProcessor();
        await processor.handle(normalized);
      } catch (err) {
        logger.warn({ err, companyId }, "slack events: processor failed");
      }
    })();
  });

  // ---------- Interactivity webhook (Phase 1 stub) ----------
  router.post(
    "/interactivity",
    express.urlencoded({ extended: true }),
    async (req: Request, res: Response) => {
      const env = readEnv();
      const stashedRaw = (req as unknown as { rawBody?: Buffer }).rawBody;
      const rawBody = stashedRaw ? stashedRaw.toString("utf-8") : "";
      const timestampHeader = req.header("x-slack-request-timestamp") ?? "";
      const signatureHeader = req.header("x-slack-signature") ?? "";

      // Interactivity payloads are url-encoded with a JSON "payload" field.
      const payloadRaw = (req.body as { payload?: string } | undefined)?.payload;
      let teamId: string | null = null;
      if (typeof payloadRaw === "string") {
        try {
          const parsed = JSON.parse(payloadRaw) as { team?: { id?: string } };
          if (typeof parsed.team?.id === "string") teamId = parsed.team.id;
        } catch {
          // ignore — signature verification below is what matters
        }
      }

      let signingSecret: string | null = null;
      if (teamId) {
        const [install] = await db
          .select()
          .from(messagingWorkspaceInstall)
          .where(
            and(
              eq(messagingWorkspaceInstall.backend, "slack"),
              eq(messagingWorkspaceInstall.externalWorkspaceRef, teamId),
            ),
          )
          .limit(1);
        if (install) {
          signingSecret = await getSigningSecretForCompany(db, install.companyId);
        }
      }
      if (!signingSecret && env?.signingSecret) {
        signingSecret = env.signingSecret;
      }
      if (!signingSecret) {
        res.status(401).json({ error: "no signing secret available" });
        return;
      }

      const ok = verifySlackSignature({
        signingSecret,
        timestampHeader,
        signatureHeader,
        rawBody,
      });
      if (!ok) {
        res.status(401).json({ error: "invalid signature" });
        return;
      }

      // Phase 1: no-op. Approval buttons land in Phase 1.5.
      res.json({});
    },
  );

  // Silence unused-import warnings if these become dead on a refactor.
  void companySecrets;

  return router;
}
