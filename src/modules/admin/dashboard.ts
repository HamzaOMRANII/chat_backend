import type { Router } from "express";
import { Chat } from "../../models/chat.js";
import { Message } from "../../models/message.js";
import { Friendship } from "../../models/friendship.js";
import { DeviceEvent } from "../../models/deviceEvent.js";
import { Session } from "../../models/session.js";
import { User, USER_STATUSES, type UserDoc } from "../../models/user.js";
import { presence } from "../../realtime/presence.js";
import { sharedCategoryIds } from "../contacts/service.js";
import type { AdminContext } from "./context.js";

/** Dashboard: counts and recent activity for the home page. */
export function registerDashboard(router: Router, { admin }: AdminContext) {
  router.get("/dashboard", admin, async (_req, res) => {
    const day = new Date(Date.now() - 24 * 3600_000);
    const [statusCounts, chatCounts, messages24h, stored, locked, pending, logins, onlineSessions] = await Promise.all([
      User.aggregate([{ $match: { role: "user" } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      Chat.aggregate([{ $match: { status: { $in: ["invited", "active"] } } }, { $group: { _id: { status: "$status", mode: "$mode" }, n: { $sum: 1 } } }]),
      Message.countDocuments({ sentAt: { $gt: day } }),
      Message.aggregate([{ $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: "$size" } } }]),
      User.find({ role: "user", lockedUntil: { $gt: new Date() } })
        .select("username lockedUntil")
        .lean(),
      User.find({ role: "user", status: "pending" }).select("username createdAt").sort({ createdAt: -1 }).limit(5).lean(),
      DeviceEvent.find({ type: "login" }).sort({ at: -1 }).limit(8).populate("userId", "username role").lean(),
      Session.find({ kind: "user", revokedAt: null, expiresAt: { $gt: new Date() } })
        .select("userId device.platform")
        .lean(),
    ]);
    const online = onlineSessions.filter((s) => presence.isOnline(s.userId));
    const count = (status: string, mode?: string) =>
      chatCounts.filter((c) => c._id.status === status && (!mode || c._id.mode === mode)).reduce((a, c) => a + c.n, 0);
    // Paused contacts: accepted friendships whose pair no longer shares a category
    const friendships = await Friendship.find({ status: "accepted" }).select("userA userB").lean();
    const people = await User.find({ _id: { $in: friendships.flatMap((f) => [f.userA, f.userB]) } })
      .select("categoryIds status")
      .lean();
    const byId = new Map(people.map((u) => [String(u._id), u]));
    const paused = friendships.filter((f) => {
      const a = byId.get(String(f.userA));
      const b = byId.get(String(f.userB));
      return !a || !b || a.status !== "approved" || b.status !== "approved" || !sharedCategoryIds(a, b).length;
    }).length;
    res.json({
      users: Object.fromEntries(USER_STATUSES.map((st) => [st, statusCounts.find((c) => c._id === st)?.n ?? 0])),
      online: { total: online.length, android: online.filter((s) => s.device?.platform === "android").length },
      chats: { active: count("active"), keep: count("active", "keep"), auto: count("active", "auto"), invited: count("invited") },
      messages: { last24h: messages24h, stored: stored[0]?.n ?? 0, storedBytes: stored[0]?.bytes ?? 0 },
      attention: {
        pending: pending.map((u) => ({ id: String(u._id), username: u.username, at: u.createdAt })),
        locked: locked.map((u) => ({ id: String(u._id), username: u.username, until: u.lockedUntil })),
        pausedContacts: paused,
      },
      logins: logins
        .filter((e) => (e.userId as unknown as UserDoc | null)?.role === "user")
        .slice(0, 5)
        .map((e) => ({
          username: (e.userId as unknown as UserDoc).username,
          userId: String((e.userId as unknown as UserDoc)._id),
          at: e.at,
          deviceName: e.deviceName ?? null,
          platform: e.platform ?? null,
        })),
    });
  });
}
