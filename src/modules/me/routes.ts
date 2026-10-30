import { Router } from "express";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { badRequest, conflict, unauthorized } from "../../lib/errors.js";
import type { Mailer } from "../../lib/mailer.js";
import { codeSchema, emailSchema, objectIdSchema, parse, secureCodeSchema } from "../../lib/validate.js";
import { hashSecret, verifySecret } from "../../lib/secrets.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { DeviceEvent } from "../../models/deviceEvent.js";
import { User } from "../../models/user.js";
import { checkCode, openChallenge, publicUser, sendCodeChallenge } from "../auth/routes.js";
import { recordEvent } from "../auth/sessions.js";
import type { DeviceSnapshot } from "../../lib/device.js";

const LOG_FIELDS = "type deviceName platform model osVersion appVersion browser os ip country city at";

export function createMeRouter(config: Config, mailer: Mailer) {
  const router = Router();

  // The user's own security log (same records the administrator sees), last 90 days.
  router.get("/security-log", requireUser(config), async (req, res) => {
    const events = await DeviceEvent.find({ userId: auth(req).user._id })
      .sort({ at: -1 })
      .limit(200)
      .select(LOG_FIELDS)
      .lean();
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

  // ---------- Secure code: signs in instead of the emailed code (hidden field on the code screen) ----------
  router.get("/secure-code", requireUser(config), async (req, res) => {
    const { user } = auth(req);
    res.json({ set: Boolean(user.secureCodeSetAt), setAt: user.secureCodeSetAt ?? null, allowed: !user.secureCodeDisabled });
  });

  const sessionDevice = (req: Parameters<typeof auth>[0]) => {
    const d = auth(req).session.device;
    return d ? ({ ...d, name: d.name ?? "" } as DeviceSnapshot) : undefined;
  };

  // Setting or removing it needs the current password, so an unlocked phone alone can't change it.
  const withPassword = async (userId: unknown, password: string) => {
    const user = await User.findById(userId).select("+passwordHash +passcodeHash");
    if (!user || !(await verifySecret(user.passwordHash, password))) throw unauthorized("Wrong password.", "wrong_password");
    return user;
  };

  router.put("/secure-code", requireUser(config), async (req, res) => {
    const body = parse(z.object({ password: z.string().min(1).max(200), secureCode: secureCodeSchema }), req.body);
    const user = await withPassword(auth(req).user._id, body.password);
    if (user.secureCodeDisabled) throw conflict("The administrator switched the secure code off for your account.", "secure_code_disabled");
    if (await verifySecret(user.passcodeHash, body.secureCode)) throw badRequest("Choose a code different from your recovery passcode.", "same_as_passcode");
    user.secureCodeHash = await hashSecret(body.secureCode);
    user.secureCodeSetAt = new Date();
    await user.save();
    await recordEvent(user._id, "secure_code_set", sessionDevice(req));
    res.json({ set: true, setAt: user.secureCodeSetAt, allowed: true });
  });

  router.delete("/secure-code", requireUser(config), async (req, res) => {
    const body = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
    const user = await withPassword(auth(req).user._id, body.password);
    user.secureCodeHash = undefined;
    user.secureCodeSetAt = undefined;
    await user.save();
    await recordEvent(user._id, "secure_code_removed", sessionDevice(req));
    res.json({ set: false, setAt: null, allowed: !user.secureCodeDisabled });
  });

  return router;
}
