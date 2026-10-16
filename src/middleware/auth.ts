import type { NextFunction, Request, Response } from "express";
import type { Config } from "../config/env.js";
import { authenticate, tokenFromRequest, type Authenticated, type SessionKind } from "../modules/auth/sessions.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: Authenticated;
  }
}

/** Requires a signed-in user. "reset" sessions (after a recovery passcode) only pass where allowed. */
export function requireUser(config: Config, { allowReset = false } = {}) {
  const kinds: SessionKind[] = allowReset ? ["user", "reset"] : ["user"];
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.auth = await authenticate(config, tokenFromRequest(req, "user"), kinds);
    next();
  };
}

export function requireAdmin(config: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.auth = await authenticate(config, tokenFromRequest(req, "admin"), ["admin"]);
    next();
  };
}

/** The authenticated user/session; only call behind requireUser/requireAdmin. */
export function auth(req: Request): Authenticated {
  if (!req.auth) throw new Error("auth() used on an unauthenticated route");
  return req.auth;
}
