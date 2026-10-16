import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { clientDeviceSchema, deviceSnapshot, type DeviceSnapshot } from "../../lib/device.js";
import { badRequest, conflict, forbidden, HttpError, locked, unauthorized } from "../../lib/errors.js";
import type { Mailer } from "../../lib/mailer.js";
import { hashSecret, maskEmail, numericCode, sameHash, sha256, verifySecret } from "../../lib/secrets.js";
import { codeSchema, emailSchema, objectIdSchema, parse, passcodeSchema, passwordSchema, usernameSchema } from "../../lib/validate.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { Challenge } from "../../models/challenge.js";
import { DeviceEvent } from "../../models/deviceEvent.js";
import { User, type UserDoc } from "../../models/user.js";
import {
  clearFailures,
  clearToken,
  deliverToken,
  isLocked,
  recordEvent,
  registerFailure,
  revokeAllSessions,
  revokeSession,
  startSession,
} from "./sessions.js";

export const CODE_MINUTES = 5;
const CODE_ATTEMPTS = 5;

const STATUS_MESSAGES: Record<string, [string, string]> = {
  pending: ["pending", "Your account is waiting for approval."],
  rejected: ["rejected", "Your request was not approved."],
  suspended: ["suspended", "This account is suspended. Contact the administrator."],
};

/** What the app gets about the signed-in user. */
export const publicUser = (u: UserDoc) => ({ id: u.id, username: u.username, email: u.email, mustReset: Boolean(u.mustReset) });

/** The sign-in before the current one, for "Last sign-in: … Not you?" */
async function previousLogin(userId: UserDoc["_id"]) {
  const [, previous] = await DeviceEvent.find({ userId, type: "login" }).sort({ at: -1 }).limit(2).lean();
  return previous ? { at: previous.at, deviceName: previous.deviceName, city: previous.city, country: previous.country } : null;
}

/** Sends a fresh 6-digit code by email and returns the challenge the client answers. */
export async function sendCodeChallenge(
  mailer: Mailer,
  user: UserDoc,
  purpose: "login" | "admin-login" | "email-change",
  device?: DeviceSnapshot,
  newEmail?: string,
) {
  await Challenge.deleteMany({ userId: user._id, purpose });
  const code = numericCode(6);
  const challenge = await Challenge.create({
    userId: user._id,
    purpose,
    codeHash: sha256(code),
    newEmail,
    device,
    expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
  });
  await mailer.sendCode({ to: newEmail ?? user.email, code, purpose, minutes: CODE_MINUTES });
  return { challengeId: challenge.id, emailHint: maskEmail(newEmail ?? user.email), expiresInMinutes: CODE_MINUTES };
}

/** Loads a live challenge and its user, or explains why it can't be used. */
export async function openChallenge(challengeId: string, purpose: "login" | "admin-login" | "email-change") {
  const challenge = await Challenge.findOne({ _id: challengeId, purpose, expiresAt: { $gt: new Date() } });
  if (!challenge) throw badRequest("This code expired. Sign in again to get a new one.", "challenge_expired");
  const user = await User.findById(challenge.userId).select("+passcodeHash");
  if (!user) throw badRequest("This code expired. Sign in again to get a new one.", "challenge_expired");
  if (isLocked(user)) throw locked("Too many wrong attempts. Try again in 30 minutes.");
  return { challenge, user };
}

/** Checks a 6-digit code against a challenge; wrong codes count toward the attempt and lock limits. */
export async function checkCode(challenge: Awaited<ReturnType<typeof openChallenge>>["challenge"], user: UserDoc, code: string) {
  if (sameHash(challenge.codeHash, sha256(code))) return;
  challenge.attempts += 1;
  if (challenge.attempts >= CODE_ATTEMPTS) await challenge.deleteOne();
  else await challenge.save();
  await registerFailure(user, challenge.device as DeviceSnapshot | undefined);
  await recordEvent(user._id, "failed_code", challenge.device as DeviceSnapshot | undefined);
  const left = CODE_ATTEMPTS - challenge.attempts;
  throw new HttpError(400, "wrong_code", left > 0 ? `Wrong code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many wrong codes. Sign in again.", {
    attemptsLeft: Math.max(left, 0),
  });
}

export function createAuthRouter(config: Config, mailer: Mailer) {
  const router = Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  const signupLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false });
  const device = (req: Request, raw: unknown) => deviceSnapshot(req, parse(clientDeviceSchema, raw));

  router.post("/signup", signupLimiter, async (req, res) => {
    const body = parse(
      z.object({
        username: usernameSchema,
        email: emailSchema,
        password: passwordSchema,
        passcode: passcodeSchema,
        privacyAccepted: z.literal(true, { error: "accept the privacy notice to continue" }),
        device: z.unknown(),
      }),
      req.body,
    );
    const d = device(req, body.device);
    if (await User.exists({ $or: [{ username: body.username }, { email: body.email }] })) {
      throw conflict("This username or email is already used.", "taken");
    }
    const user = await User.create({
      username: body.username,
      email: body.email,
      passwordHash: await hashSecret(body.password),
      passcodeHash: await hashSecret(body.passcode),
      privacyAcceptedAt: new Date(),
    });
    await recordEvent(user._id, "signup", d);
    res.status(201).json({ status: "pending", username: user.username });
  });

  // Step 1: username + password. Account status is only revealed after a correct password.
  router.post("/login", authLimiter, async (req, res) => {
    const body = parse(z.object({ username: usernameSchema, password: z.string().min(1).max(200), device: z.unknown() }), req.body);
    const d = device(req, body.device);
    const user = await User.findOne({ username: body.username, role: "user" }).select("+passwordHash");
    if (user && isLocked(user)) throw locked("Too many wrong attempts. Try again in 30 minutes.");
    if (!user || !(await verifySecret(user.passwordHash, body.password))) {
      if (user) {
        await registerFailure(user, d);
        await recordEvent(user._id, "failed_password", d);
      }
      throw unauthorized("Wrong username or password.", "wrong_credentials");
    }
    const blocked = STATUS_MESSAGES[user.status];
    if (blocked) throw forbidden(blocked[1], blocked[0]);
    res.json(await sendCodeChallenge(mailer, user, "login", d));
  });

  // Step 2a: the 6-digit code from the email.
  router.post("/verify-code", authLimiter, async (req, res) => {
    const body = parse(z.object({ challengeId: objectIdSchema, code: codeSchema }), req.body);
    const { challenge, user } = await openChallenge(body.challengeId, "login");
    await checkCode(challenge, user, body.code);
    await challenge.deleteOne();
    await clearFailures(user);
    const d = challenge.device as DeviceSnapshot;
    const { token } = await startSession(config, user, user.mustReset ? "reset" : "user", d);
    await recordEvent(user._id, "login", d);
    res.json({ user: publicUser(user), lastLogin: await previousLogin(user._id), ...deliverToken(req, res, config, "user", token) });
  });

  // Step 2b: lost access to email -> the memorised recovery passcode. Works once: a reset follows.
  router.post("/verify-passcode", authLimiter, async (req, res) => {
    const body = parse(z.object({ challengeId: objectIdSchema, passcode: passcodeSchema }), req.body);
    const { challenge, user } = await openChallenge(body.challengeId, "login");
    const d = challenge.device as DeviceSnapshot;
    if (!(await verifySecret(user.passcodeHash, body.passcode))) {
      await registerFailure(user, d);
      await recordEvent(user._id, "failed_passcode", d);
      throw new HttpError(400, "wrong_passcode", "Wrong passcode.");
    }
    await challenge.deleteOne();
    await clearFailures(user);
    user.mustReset = true;
    await user.save();
    const { token } = await startSession(config, user, "reset", d);
    await recordEvent(user._id, "passcode_used", d);
    res.json({ user: publicUser(user), ...deliverToken(req, res, config, "user", token) });
  });

  // Lost both email and passcode: one-time code the administrator gave out (backoffice "Reset access").
  router.post("/admin-reset", authLimiter, async (req, res) => {
    const body = parse(z.object({ username: usernameSchema, code: z.string().regex(/^\d{10}$/), device: z.unknown() }), req.body);
    const d = device(req, body.device);
    const user = await User.findOne({ username: body.username, role: "user", status: "approved" }).select("+adminResetHash");
    if (user && isLocked(user)) throw locked("Too many wrong attempts. Try again in 30 minutes.");
    const valid = user?.adminResetExpiresAt && user.adminResetExpiresAt > new Date() && (await verifySecret(user.adminResetHash, body.code));
    if (!user || !valid) {
      if (user) await registerFailure(user, d);
      throw unauthorized("This reset code is wrong or expired.", "wrong_reset_code");
    }
    user.adminResetHash = undefined;
    user.adminResetExpiresAt = undefined;
    user.mustReset = true;
    await clearFailures(user);
    await user.save();
    const { token } = await startSession(config, user, "reset", d);
    await recordEvent(user._id, "admin_reset_used", d);
    res.json({ user: publicUser(user), ...deliverToken(req, res, config, "user", token) });
  });

  // After a passcode or admin-reset sign-in: new password + new passcode, then a normal session.
  router.post("/reset-credentials", authLimiter, requireUser(config, { allowReset: true }), async (req, res) => {
    const body = parse(z.object({ password: passwordSchema, passcode: passcodeSchema }), req.body);
    const { session } = auth(req);
    const user = await User.findById(auth(req).user._id).select("+passcodeHash");
    if (!user) throw unauthorized();
    if (!user.mustReset) throw badRequest("Nothing to reset.", "no_reset_needed");
    if (await verifySecret(user.passcodeHash, body.passcode)) throw badRequest("Choose a passcode different from the old one.", "same_passcode");
    user.passwordHash = await hashSecret(body.password);
    user.passcodeHash = await hashSecret(body.passcode);
    user.mustReset = false;
    user.credentialsChangedAt = new Date();
    await user.save();
    const d = session.device ? ({ ...session.device, name: session.device.name ?? "" } as DeviceSnapshot) : undefined;
    await revokeAllSessions(user._id, "credentials_changed");
    const { token } = await startSession(config, user, "user", d);
    await recordEvent(user._id, "credentials_reset", d);
    res.json({ user: publicUser(user), ...deliverToken(req, res, config, "user", token) });
  });

  router.post("/logout", requireUser(config, { allowReset: true }), async (req, res) => {
    const { user, session } = auth(req);
    await revokeSession(session, "logout");
    await recordEvent(user._id, "logout", session.device ? ({ ...session.device, name: session.device.name ?? "" } as DeviceSnapshot) : undefined);
    clearToken(res, config, "user");
    res.json({ ok: true });
  });

  router.get("/me", requireUser(config, { allowReset: true }), async (req, res) => {
    const { user, session } = auth(req);
    res.json({ user: publicUser(user), session: { kind: session.kind, device: session.device }, lastLogin: await previousLogin(user._id) });
  });

  return router;
}
