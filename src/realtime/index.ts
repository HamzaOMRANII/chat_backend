import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { Config } from "../config/env.js";
import { bus } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import { User } from "../models/user.js";
import { authenticate, COOKIE } from "../modules/auth/sessions.js";

function cookieToken(header: string | undefined) {
  for (const part of (header ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE.user) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export function createRealtime(httpServer: HttpServer, config: Config) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: [config.APP_ORIGIN, config.NATIVE_APP_ORIGIN, config.ADMIN_ORIGIN], credentials: true },
    // Live-mode drafts are small; keep frames small so nobody can push large payloads
    maxHttpBufferSize: 64 * 1024,
  });

  // Same session as the API: the web app's cookie, or the Android app's token in the handshake.
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string }).token ?? cookieToken(socket.handshake.headers.cookie);
      const { user, session } = await authenticate(config, token, ["user"]);
      socket.data.userId = user.id;
      socket.data.sessionId = session.id;
      next();
    } catch (err) {
      next(Object.assign(new Error("unauthorized"), { data: (err as { details?: unknown }).details }));
    }
  });

  io.on("connection", (socket) => {
    void socket.join([`user:${socket.data.userId}`, `session:${socket.data.sessionId}`]);
    socket.on("disconnect", () => {
      void User.updateOne({ _id: socket.data.userId }, { lastSeenAt: new Date() }).catch(() => {});
    });
  });

  // A session ended elsewhere (new sign-in, suspension, admin): tell its sockets why, then drop them.
  bus.on("session:revoked", (event) => {
    io.to(`session:${event.sessionId}`).emit("session:revoked", { reason: event.reason, by: event.by });
    io.in(`session:${event.sessionId}`).disconnectSockets(true);
    logger.info({ sessionId: event.sessionId, reason: event.reason }, "session revoked");
  });

  return io;
}
