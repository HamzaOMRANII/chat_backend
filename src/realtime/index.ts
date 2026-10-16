import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { Config } from "../config/env.js";
import { logger } from "../lib/logger.js";

export function createRealtime(httpServer: HttpServer, config: Config) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: [config.APP_ORIGIN, config.NATIVE_APP_ORIGIN, config.ADMIN_ORIGIN], credentials: true },
    // Live-mode drafts are small; keep frames small so nobody can push large payloads
    maxHttpBufferSize: 64 * 1024,
  });

  io.on("connection", (socket) => {
    logger.debug({ id: socket.id }, "socket connected");
  });

  return io;
}
