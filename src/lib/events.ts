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
}

export const bus = new Bus();
