/** Who has the app open right now (open sockets per user). One API process, so memory is enough. */
const sockets = new Map<string, number>();
// Per session: each open socket and whether its app is on screen (a hidden tab, an app in the background)
const screens = new Map<string, Map<string, boolean>>();

export const presence = {
  isOnline: (userId: string | { toString(): string }) => (sockets.get(String(userId)) ?? 0) > 0,
  /** Returns true when the user just came online. */
  connect(userId: string) {
    const n = (sockets.get(userId) ?? 0) + 1;
    sockets.set(userId, n);
    return n === 1;
  },
  /** Returns true when the user just went offline. */
  disconnect(userId: string) {
    const n = (sockets.get(userId) ?? 1) - 1;
    if (n <= 0) sockets.delete(userId);
    else sockets.set(userId, n);
    return n <= 0;
  },
  /** A socket of this session reports whether its app is visible. */
  visibility(sessionId: string, socketId: string, visible: boolean) {
    const map = screens.get(sessionId) ?? new Map<string, boolean>();
    map.set(socketId, visible);
    screens.set(sessionId, map);
  },
  leave(sessionId: string, socketId: string) {
    const map = screens.get(sessionId);
    map?.delete(socketId);
    if (map && !map.size) screens.delete(sessionId);
  },
  /** True when this session has the app on screen: it shows events itself, no system notification needed. */
  onScreen: (sessionId: string | { toString(): string }) => [...(screens.get(String(sessionId))?.values() ?? [])].some(Boolean),
};
