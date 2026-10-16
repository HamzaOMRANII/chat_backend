import { EventEmitter } from "node:events";

export type SessionRevoked = {
  sessionId: string;
  userId: string;
  reason: string;
  by?: { name?: string; city?: string; country?: string; at: string };
};

/** In-process bus between the HTTP side and Socket.IO (e.g. "close this session's sockets now"). */
class Bus extends EventEmitter {
  sessionRevoked(event: SessionRevoked) {
    this.emit("session:revoked", event);
  }
  /** Sends a socket event to these users' open apps (e.g. "msg:new", "chats:changed", "typing"). */
  toUsers(userIds: (string | { toString(): string })[], event: string, payload?: unknown) {
    if (userIds.length) this.emit("to:users", { userIds: [...new Set(userIds.map(String))], event, payload });
  }
  /** These users' contacts or requests changed: their apps reload the list. */
  contactsChanged(userIds: (string | { toString(): string })[]) {
    if (userIds.length) this.emit("contacts:changed", [...new Set(userIds.map(String))]);
  }
}

export const bus = new Bus();
