import type { CookieOptions, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import type { Config } from "../../config/env.js";
import type { DeviceSnapshot } from "../../lib/device.js";
import { bus } from "../../lib/events.js";
import { unauthorized } from "../../lib/errors.js";
import { DeviceEvent, type DeviceEventFields } from "../../models/deviceEvent.js";
import { PushSubscription } from "../../models/pushSubscription.js";
import { Session, type SessionDoc } from "../../models/session.js";
import { User, type UserDoc } from "../../models/user.js";

export type SessionKind = "user" | "reset" | "admin";

const TTL_SECONDS: Record<SessionKind, number> = {
  user: 30 * 24 * 60 * 60,
  reset: 15 * 60,
  admin: 2 * 60 * 60,
};
export const COOKIE = { user: "hc_session", admin: "hc_admin" } as const;
// The user cookie must also reach /socket.io (live updates on the web), so it covers the whole site.
const COOKIE_PATH = { user: "/", admin: "/api/admin" } as const;
// Before 2026-10-16 the user cookie was scoped to /api, which kept it away from the socket
const LEGACY_USER_COOKIE_PATH = "/api";

const MAX_FAILURES = 5;
const LOCK_MINUTES = 30;

// use "socket": a short ticket that only opens the live connection (never accepted by the API)
type TokenPayload = { sid: string; sub: string; kind: SessionKind; use?: "socket" };

/** The Android app has no cookie jar for our domain: it asks for the token in the response body. */
export const isAppRequest = (req: Request) => req.get("x-client") === "android";

const sessionDevice = (d?: DeviceSnapshot) =>
  d && {
    deviceId: d.deviceId,
    name: d.name,
    platform: d.platform,
    model: d.model,
    osVersion: d.osVersion,
    appVersion: d.appVersion,
    browser: d.browser,
    os: d.os,
    ip: d.ip,
    country: d.country,
    city: d.city,
  };

export async function recordEvent(userId: Types.ObjectId | string, type: DeviceEventFields["type"], d?: DeviceSnapshot) {
  await DeviceEvent.create({
    userId,
    type,
    ...(d && {
      deviceId: d.deviceId,
      deviceName: d.name,
      platform: d.platform,
      model: d.model,
      manufacturer: d.manufacturer,
      osVersion: d.osVersion,
      appVersion: d.appVersion,
      network: d.network,
      browser: d.browser,
      os: d.os,
      deviceType: d.deviceType,
      screen: d.screen,
      language: d.language,
      timezone: d.timezone,
      ip: d.ip,
      country: d.country,
      city: d.city,
    }),
  });
}

/** Counts a wrong password/code/passcode; the 5th in a row locks sign-in for 30 minutes. */
export async function registerFailure(user: UserDoc, d?: DeviceSnapshot) {
  user.failedAttempts = (user.failedAttempts ?? 0) + 1;
  if (user.failedAttempts >= MAX_FAILURES) {
    user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
    user.failedAttempts = 0;
    await recordEvent(user._id, "locked", d);
  }
  await user.save();
}

export const isLocked = (user: UserDoc) => Boolean(user.lockedUntil && user.lockedUntil > new Date());

export async function clearFailures(user: UserDoc) {
  if (user.failedAttempts || user.lockedUntil) {
    user.failedAttempts = 0;
    user.lockedUntil = undefined;
    await user.save();
  }
}

/** Ends a session now, tells its open sockets, and records why. */
export async function revokeSession(session: SessionDoc, reason: NonNullable<SessionDoc["revokeReason"]>, by?: DeviceSnapshot) {
  if (session.revokedAt) return;
  session.revokedAt = new Date();
  session.revokeReason = reason;
  if (by) session.revokedBy = sessionDevice(by);
  await session.save();
  // Its browser notifications stop with it
  await PushSubscription.deleteMany({ sessionId: session._id });
  bus.sessionRevoked({
    sessionId: session.id,
    userId: String(session.userId),
    reason,
    by: by && { name: by.name, city: by.city, country: by.country, at: new Date().toISOString() },
  });
}

/** Ends every live session of a user (suspension, deletion, new credentials). */
export async function revokeAllSessions(userId: Types.ObjectId | string, reason: NonNullable<SessionDoc["revokeReason"]>, exceptId?: string) {
  const live = await Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } });
  for (const s of live) if (s.id !== exceptId) await revokeSession(s, reason);
}

/**
 * Creates a session and its token. A new full "user" session closes the previous one:
 * H_CHAT allows one device at a time.
 */
export async function startSession(config: Config, user: UserDoc, kind: SessionKind, device?: DeviceSnapshot) {
  if (kind === "user") {
    const previous = await Session.find({ userId: user._id, kind: { $in: ["user", "reset"] }, revokedAt: null, expiresAt: { $gt: new Date() } });
    for (const s of previous) {
      await revokeSession(s, "new_login", device);
      if (s.kind === "user") await recordEvent(user._id, "kicked", s.device ? ({ ...s.device, name: s.device.name ?? "" } as DeviceSnapshot) : undefined);
    }
  }
  const session = await Session.create({
    userId: user._id,
    kind,
    device: sessionDevice(device),
    expiresAt: new Date(Date.now() + TTL_SECONDS[kind] * 1000),
  });
  if (kind === "user") {
    user.activeSessionId = session._id;
    user.lastSeenAt = new Date();
    await user.save();
  }
  const secret = kind === "admin" ? config.ADMIN_JWT_SECRET : config.JWT_SECRET;
  const token = jwt.sign({ sid: session.id, sub: user.id, kind } satisfies TokenPayload, secret, {
    algorithm: "HS256",
    expiresIn: TTL_SECONDS[kind],
  });
  return { session, token };
}

function cookieOptions(config: Config, kind: SessionKind): CookieOptions {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    path: kind === "admin" ? COOKIE_PATH.admin : COOKIE_PATH.user,
    maxAge: TTL_SECONDS[kind] * 1000,
  };
}

/** Web: httpOnly cookie. Android app: the token goes in the JSON body instead. */
export function deliverToken(req: Request, res: Response, config: Config, kind: SessionKind, token: string) {
  if (isAppRequest(req) && kind !== "admin") return { token };
  if (kind !== "admin") res.clearCookie(COOKIE.user, { ...withoutMaxAge(cookieOptions(config, kind)), path: LEGACY_USER_COOKIE_PATH });
  res.cookie(kind === "admin" ? COOKIE.admin : COOKIE.user, token, cookieOptions(config, kind));
  return {};
}

function withoutMaxAge(options: CookieOptions) {
  const { maxAge: _maxAge, ...rest } = options;
  return rest;
}

export function clearToken(res: Response, config: Config, kind: "user" | "admin") {
  const options = withoutMaxAge(cookieOptions(config, kind));
  res.clearCookie(kind === "admin" ? COOKIE.admin : COOKIE.user, options);
  if (kind === "user") res.clearCookie(COOKIE.user, { ...options, path: LEGACY_USER_COOKIE_PATH });
}

export function tokenFromRequest(req: Request, kind: "user" | "admin") {
  const header = req.get("authorization") ?? "";
  if (kind === "user" && header.startsWith("Bearer ")) return header.slice(7).trim();
  return (req.cookies as Record<string, string | undefined>)[kind === "admin" ? COOKIE.admin : COOKIE.user];
}

export type Authenticated = { user: UserDoc; session: SessionDoc };

/**
 * Resolves the token to a live session and an allowed user. A revoked session answers 401
 * "session_revoked" with the device that replaced it, so the app can show "signed in elsewhere".
 */
/**
 * Web app: a 60-second ticket for the live connection, asked for with the session cookie. The web app connects
 * with it instead of relying on the browser sending the cookie to /socket.io.
 */
export function socketTicket(config: Config, session: SessionDoc) {
  return jwt.sign({ sid: session.id, sub: String(session.userId), kind: "user", use: "socket" } satisfies TokenPayload, config.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: 60,
  });
}

export async function authenticate(config: Config, token: string | undefined, allowed: SessionKind[], opts: { socket?: boolean } = {}): Promise<Authenticated> {
  if (!token) throw unauthorized();
  let payload: TokenPayload;
  try {
    const secret = allowed.includes("admin") ? config.ADMIN_JWT_SECRET : config.JWT_SECRET;
    payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as TokenPayload;
  } catch {
    throw unauthorized("Your session ended. Sign in again.", "session_expired");
  }
  if (!allowed.includes(payload.kind)) throw unauthorized();
  if (payload.use === "socket" && !opts.socket) throw unauthorized();
  const session = await Session.findById(payload.sid);
  if (!session || session.expiresAt < new Date()) throw unauthorized("Your session ended. Sign in again.", "session_expired");
  if (session.revokedAt) {
    const by = session.revokedBy;
    throw unauthorized("This session was closed.", session.revokeReason === "new_login" ? "session_revoked" : "session_closed", {
      reason: session.revokeReason,
      at: session.revokedAt.toISOString(),
      by: by ? { name: by.name, city: by.city, country: by.country } : undefined,
    });
  }
  const user = await User.findById(session.userId);
  if (!user || user.status !== "approved") throw unauthorized("This account can't be used.", "account_unavailable");
  if (payload.kind === "admin" ? user.role !== "admin" : user.role !== "user") throw unauthorized();
  return { user, session };
}
