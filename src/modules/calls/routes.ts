import { Router } from "express";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { parse } from "../../lib/validate.js";
import { logger } from "../../lib/logger.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { turnCredentials } from "./service.js";

/** Mounted on /api: /api/calls/turn and /api/me/calls. */
export function createCallsRouter(config: Config) {
  const router = Router();
  router.use(["/calls", "/me/calls"], requireUser(config));

  // Relay credentials, valid one hour, for this user only
  router.get("/calls/turn", (req, res) => {
    res.json(turnCredentials(config, auth(req).user.id));
  });

  // A device's numbers about a call's sound (bytes, levels, player state): logged to find audio problems
  router.post("/calls/diag", (req, res) => {
    const body = parse(z.object({ callId: z.string().max(40), data: z.record(z.string(), z.unknown()) }), req.body);
    if (JSON.stringify(body.data).length < 4000) logger.info({ user: auth(req).user.username, platform: auth(req).session.device?.platform, callId: body.callId, ...body.data }, "call audio");
    res.json({ ok: true });
  });

  router.get("/me/calls", (req, res) => {
    res.json({ receive: auth(req).user.receiveCalls !== false });
  });
  router.put("/me/calls", async (req, res) => {
    const { receive } = parse(z.object({ receive: z.boolean() }), req.body);
    const user = auth(req).user;
    user.receiveCalls = receive;
    await user.save();
    res.json({ receive });
  });

  return router;
}
