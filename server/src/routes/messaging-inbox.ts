import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "../messaging/router.js";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { getInboxPreferences, setInboxPreferences } from "../messaging/inbox.js";

const patchSchema = z.object({
  prefs: z.record(z.string(), z.boolean()),
});

function resolveActorUserId(req: Request): string {
  if (req.actor.type !== "board") {
    throw forbidden("Board authentication required");
  }
  if (!req.actor.userId) {
    throw forbidden("Board user context required");
  }
  return req.actor.userId;
}

function resolveCompanyId(req: Request): string {
  const companyId =
    (req.query.companyId as string | undefined) ??
    (req.body?.companyId as string | undefined);
  if (!companyId) throw badRequest("companyId is required");
  assertCompanyAccess(req, companyId);
  return companyId;
}

export function messagingInboxRoutes(db: Db): Router {
  const router = Router();

  router.get("/inbox-prefs", async (req: Request, res: Response) => {
    const userId = resolveActorUserId(req);
    const companyId = resolveCompanyId(req);
    const prefs = await getInboxPreferences(db, { companyId, userId });
    res.json({ prefs });
  });

  router.patch(
    "/inbox-prefs",
    validate(patchSchema),
    async (req: Request, res: Response) => {
      const userId = resolveActorUserId(req);
      const companyId = resolveCompanyId(req);
      const prefs = await setInboxPreferences(db, {
        companyId,
        userId,
        prefs: req.body.prefs,
      });
      res.json({ prefs });
    },
  );

  return router;
}
