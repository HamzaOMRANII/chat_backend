import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { COOKIE } from "./modules/auth/sessions.js";
import { pinoHttp } from "pino-http";
import type { Config } from "./config/env.js";
import { HttpError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import type { Mailer } from "./lib/mailer.js";
import { createAdminRouter } from "./modules/admin/routes.js";
import { createAuthRouter } from "./modules/auth/routes.js";
import { createChatsRouter } from "./modules/chats/routes.js";
import { createLiveRouter } from "./modules/live/routes.js";
import { createFilesRouter } from "./modules/files/routes.js";
import { createExportsRouter } from "./modules/exports/routes.js";
import { createCallsRouter } from "./modules/calls/routes.js";
import { appConfigRouter } from "./modules/appConfig.js";
import { createGroupsRouter } from "./modules/groups/routes.js";
import { configureMedia } from "./modules/files/service.js";
import { configureFcm } from "./modules/notify/fcm.js";
import { createContactsRouter } from "./modules/contacts/routes.js";
import { createMeRouter } from "./modules/me/routes.js";
import { createNotifyRouter } from "./modules/notify/routes.js";
import { configurePush } from "./modules/notify/service.js";
import { healthRouter } from "./routes/health.js";

export function createApp(config: Config, mailer: Mailer) {
  const app = express();
  configurePush(config);

  app.disable("x-powered-by");
  // nginx sits on 127.0.0.1 and passes the real visitor IP (already resolved from Cloudflare)
  app.set("trust proxy", "loopback");

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/health" } }));
  app.use(helmet());
  app.use(
    cors({
      origin: [config.APP_ORIGIN, config.NATIVE_APP_ORIGIN, config.ADMIN_ORIGIN],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  // Signed in: 600 requests a minute per session (a whole office behind one address isn't blocked together).
  // Not signed in: 120 a minute per address. Sign-in, sign-up and ID searches have their own, stricter limits.
  const sessionKey = (req: express.Request) => {
    const header = req.headers.authorization?.replace(/^Bearer /, "");
    const cookie = (req.cookies as Record<string, string> | undefined)?.[COOKIE.user] ?? (req.cookies as Record<string, string> | undefined)?.[COOKIE.admin];
    const token = header || cookie;
    // The token's signature part identifies the session without decoding it here
    return token ? `s:${token.slice(-24)}` : null;
  };
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: (req) => (sessionKey(req) ? 600 : 120),
      keyGenerator: (req) => sessionKey(req) ?? `ip:${ipKeyGenerator(req.ip ?? "")}`,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Wait a minute and try again.", code: "rate_limited" },
    }),
  );

  app.use("/api/health", healthRouter);
  app.use("/api/app/config", appConfigRouter);
  app.use("/api/auth", createAuthRouter(config, mailer));
  // /api/calls/turn, /api/me/calls (before /api/me)
  app.use("/api", createCallsRouter(config));
  app.use("/api/me", createMeRouter(config, mailer));
  app.use("/api/contacts", createContactsRouter(config));
  // /api/chats/… and /api/keys/identity
  app.use("/api", createChatsRouter(config));
  // /api/files/…, /api/media, /api/chats/:id/files
  configureMedia(config.MEDIA_DIR);
  void configureFcm(config.NODE_ENV === "test" ? undefined : config.FIREBASE_SERVICE_ACCOUNT);
  app.use("/api", createFilesRouter(config));
  // /api/chats/:id/exports, /api/exports/…
  app.use("/api", createExportsRouter(config));
  // /api/groups/…
  app.use("/api", createGroupsRouter(config));
  // /api/live/…
  app.use("/api", createLiveRouter(config));
  // /api/notifications/…
  app.use("/api", createNotifyRouter(config));
  app.use("/api/admin", createAdminRouter(config, mailer));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...(err.details && { details: err.details }) });
      return;
    }
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Invalid JSON", code: "invalid_json" });
      return;
    }
    if ((err as { code?: number }).code === 11000) {
      res.status(409).json({ error: "This value is already used.", code: "taken" });
      return;
    }
    logger.error({ err }, "unhandled error");
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
