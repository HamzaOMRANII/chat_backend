import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import type { Config } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { healthRouter } from "./routes/health.js";

export function createApp(config: Config) {
  const app = express();

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

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "unhandled error");
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
