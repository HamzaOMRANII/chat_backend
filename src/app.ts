import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
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
import { configureMedia } from "./modules/files/service.js";
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
  app.use(
    "/api",
    rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }),
  );

  app.use("/api/health", healthRouter);
  app.use("/api/auth", createAuthRouter(config, mailer));
  app.use("/api/me", createMeRouter(config, mailer));
  app.use("/api/contacts", createContactsRouter(config));
  // /api/chats/… and /api/keys/identity
  app.use("/api", createChatsRouter(config));
  // /api/files/…, /api/media, /api/chats/:id/files
  configureMedia(config.MEDIA_DIR);
  app.use("/api", createFilesRouter(config));
  // /api/chats/:id/exports, /api/exports/…
  app.use("/api", createExportsRouter(config));
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
