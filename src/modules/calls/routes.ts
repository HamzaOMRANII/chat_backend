import { Router } from "express";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { parse } from "../../lib/validate.js";
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
