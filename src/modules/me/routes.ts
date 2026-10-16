import { Router } from "express";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { conflict } from "../../lib/errors.js";
import type { Mailer } from "../../lib/mailer.js";
import { codeSchema, emailSchema, objectIdSchema, parse } from "../../lib/validate.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { DeviceEvent } from "../../models/deviceEvent.js";
import { User } from "../../models/user.js";
import { checkCode, openChallenge, publicUser, sendCodeChallenge } from "../auth/routes.js";
import { recordEvent } from "../auth/sessions.js";

const LOG_FIELDS = "type deviceName platform model osVersion appVersion browser os ip country city at";

export function createMeRouter(config: Config, mailer: Mailer) {
  const router = Router();

  // The user's own security log (same records the administrator sees), last 90 days.
  router.get("/security-log", requireUser(config), async (req, res) => {
    const events = await DeviceEvent.find({ userId: auth(req).user._id }).sort({ at: -1 }).limit(200).select(LOG_FIELDS).lean();
    res.json({ events, current: auth(req).session.device });
  });

  // New email: a code goes to the new address; the change applies once it's confirmed.
  router.post("/email", requireUser(config), async (req, res) => {
    const { email } = parse(z.object({ email: emailSchema }), req.body);
    const { user } = auth(req);
    if (email === user.email) return res.json({ unchanged: true });
    if (await User.exists({ email })) throw conflict("This email is already used.", "taken");
    res.json(await sendCodeChallenge(mailer, user, "email-change", undefined, email));
  });

  router.post("/email/verify", requireUser(config), async (req, res) => {
    const body = parse(z.object({ challengeId: objectIdSchema, code: codeSchema }), req.body);
    const { challenge, user } = await openChallenge(body.challengeId, "email-change");
    if (String(user._id) !== String(auth(req).user._id)) throw conflict("This code belongs to another account.");
    await checkCode(challenge, user, body.code);
    await challenge.deleteOne();
    if (await User.exists({ email: challenge.newEmail, _id: { $ne: user._id } })) throw conflict("This email is already used.", "taken");
    user.email = challenge.newEmail!;
    await user.save();
    await recordEvent(user._id, "email_changed");
    res.json({ user: publicUser(user) });
  });

  return router;
}
