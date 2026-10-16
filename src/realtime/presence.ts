/** Who has the app open right now (open sockets per user). One API process, so memory is enough. */
const sockets = new Map<string, number>();

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
};
