import type { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { clientDeviceSchema, deviceSnapshot, type DeviceSnapshot } from "../../lib/device.js";
import { locked, unauthorized } from "../../lib/errors.js";
import { verifySecret } from "../../lib/secrets.js";
import { codeSchema, objectIdSchema, parse, usernameSchema } from "../../lib/validate.js";
import { auth } from "../../middleware/auth.js";
import { User } from "../../models/user.js";
import { checkCode, openChallenge, sendCodeChallenge } from "../auth/routes.js";
import { clearFailures, clearToken, deliverToken, isLocked, recordEvent, registerFailure, revokeSession, startSession } from "../auth/sessions.js";
import type { AdminContext } from "./context.js";

/** Admin sign-in: password, then a code sent to the admin's email. */
export function registerAuth(router: Router, { admin, config, mailer }: AdminContext) {
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

  router.post("/auth/login", authLimiter, async (req, res) => {
    const body = parse(z.object({ username: usernameSchema, password: z.string().min(1).max(200), device: z.unknown() }), req.body);
    const d = deviceSnapshot(req, parse(clientDeviceSchema, body.device));
    const user = await User.findOne({ username: body.username, role: "admin", status: "approved" }).select("+passwordHash");
    if (user && isLocked(user)) throw locked("Too many wrong attempts. Try again in 30 minutes.");
    if (!user || !(await verifySecret(user.passwordHash, body.password))) {
      if (user) await registerFailure(user, d);
      throw unauthorized("Wrong username or password.", "wrong_credentials");
    }
    res.json(await sendCodeChallenge(mailer, user, "admin-login", d));
  });

  router.post("/auth/verify-code", authLimiter, async (req, res) => {
    const body = parse(z.object({ challengeId: objectIdSchema, code: codeSchema }), req.body);
    const { challenge, user } = await openChallenge(body.challengeId, "admin-login");
    await checkCode(challenge, user, body.code);
    await challenge.deleteOne();
    await clearFailures(user);
    const d = challenge.device as DeviceSnapshot;
    const { token } = await startSession(config, user, "admin", d);
    await recordEvent(user._id, "login", d);
    deliverToken(req, res, config, "admin", token);
    res.json({ admin: { id: user.id, username: user.username } });
  });

  router.post("/auth/logout", admin, async (req, res) => {
    await revokeSession(auth(req).session, "logout");
    clearToken(res, config, "admin");
    res.json({ ok: true });
  });

  router.get("/auth/me", admin, (req, res) => {
    res.json({ admin: { id: auth(req).user.id, username: auth(req).user.username } });
  });
}
