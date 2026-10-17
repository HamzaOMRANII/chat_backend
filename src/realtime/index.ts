import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { Config } from "../config/env.js";
import { bus } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import { Chat } from "../models/chat.js";
import { User } from "../models/user.js";
import { authenticate, COOKIE } from "../modules/auth/sessions.js";
import { relatedUserIds } from "../modules/contacts/service.js";
import { peerOf, userBack, userDropped } from "../modules/live/service.js";
import { presence } from "./presence.js";

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
    // Phones drop connections silently (sleep, network change): notice within ~20 s instead of ~45 s
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });

  // Same session as the API: the web app's cookie, or the Android app's token in the handshake.
  io.use(async (socket, next) => {
    try {
      const given = socket.handshake.auth as { token?: string; ticket?: string };
      const token = given.ticket ?? given.token ?? cookieToken(socket.handshake.headers.cookie);
      const { user, session } = await authenticate(config, token, ["user"], { socket: true });
      socket.data.userId = user.id;
      socket.data.sessionId = session.id;
      next();
    } catch (err) {
      logger.warn({ code: (err as { code?: string }).code, how: (socket.handshake.auth as { ticket?: string }).ticket ? "ticket" : (socket.handshake.auth as { token?: string }).token ? "token" : "cookie" }, "socket refused");
      next(Object.assign(new Error("unauthorized"), { data: (err as { details?: unknown }).details }));
    }
  });

  // Online / last seen: contacts reload their list when someone opens or closes the app.
  const announcePresence = (userId: string) =>
    void relatedUserIds(userId)
      .then((ids) => bus.contactsChanged(ids))
      .catch(() => {});

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    void socket.join([`user:${userId}`, `session:${socket.data.sessionId}`]);
    if (presence.connect(userId)) {
      announcePresence(userId);
      void userBack(userId).catch(() => {});
    }
    // On screen or in the background: decides whether a notification also goes out as a Web Push
    const sessionId = socket.data.sessionId as string;
    presence.visibility(sessionId, socket.id, (socket.handshake.auth as { visible?: unknown }).visible !== false);
    socket.on("visibility", (payload: unknown) => presence.visibility(sessionId, socket.id, (payload as { visible?: unknown } | null)?.visible !== false));
    // The app checks the connection is really alive when it comes back on screen
    socket.on("alive", (_payload: unknown, ack?: unknown) => typeof ack === "function" && ack(true));
    // "is typing…": relayed to the other participant of an active chat, never stored
    socket.on("typing", (payload: unknown) => {
      const chatId = (payload as { chatId?: unknown } | null)?.chatId;
      if (typeof chatId !== "string" || !/^[a-f0-9]{24}$/.test(chatId)) return;
      void Chat.findOne({ _id: chatId, participants: userId, status: "active" })
        .select("participants")
        .lean()
        .then((chat) => {
          const other = chat?.participants.find((p) => String(p) !== userId);
          if (other) io.to(`user:${String(other)}`).emit("typing", { chatId });
        })
        .catch(() => {});
    });
    // Live chat: what one side types, encrypted on the phone, relayed to the other and never stored
    socket.on("live", (payload: unknown) => {
      const p = payload as { sessionId?: unknown; nonce?: unknown; ct?: unknown } | null;
      if (typeof p?.sessionId !== "string" || !/^[a-f0-9]{24}$/.test(p.sessionId)) return;
      if (typeof p.nonce !== "string" || p.nonce.length !== 32 || typeof p.ct !== "string" || p.ct.length > 60_000) return;
      const { sessionId, nonce, ct } = p as { sessionId: string; nonce: string; ct: string };
      void peerOf(sessionId, userId)
        .then((peer) => peer && io.to(`user:${peer}`).emit("live", { sessionId, nonce, ct }))
        .catch(() => {});
    });
    socket.on("disconnect", () => {
      presence.leave(sessionId, socket.id);
      const wentOffline = presence.disconnect(userId);
      if (wentOffline) void userDropped(userId).catch(() => {});
      void User.updateOne({ _id: userId }, { lastSeenAt: new Date() })
        .then(() => wentOffline && announcePresence(userId))
        .catch(() => {});
    });
  });

  bus.on("to:users", ({ userIds, event, payload }: { userIds: string[]; event: string; payload?: unknown }) => {
    io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
  });

  bus.on("contacts:changed", (userIds: string[]) => {
    io.to(userIds.map((id) => `user:${id}`)).emit("contacts:changed");
  });

  // A session ended elsewhere (new sign-in, suspension, admin): tell its sockets why, then drop them.
  bus.on("session:revoked", (event) => {
    io.to(`session:${event.sessionId}`).emit("session:revoked", { reason: event.reason, by: event.by });
    io.in(`session:${event.sessionId}`).disconnectSockets(true);
    logger.info({ sessionId: event.sessionId, reason: event.reason }, "session revoked");
  });

  return io;
}
