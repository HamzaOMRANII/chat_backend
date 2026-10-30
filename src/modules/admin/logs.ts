import type { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { parse } from "../../lib/validate.js";
import { AdminLog } from "../../models/adminLog.js";
import { User, type UserDoc } from "../../models/user.js";
import type { AdminContext } from "./context.js";

/** Activity log of every backoffice action. */
export function registerLogs(router: Router, { admin }: AdminContext) {
  // Filters: action, admin, a target or detail text; pages of 100 (before = the last row's time)
  router.get("/logs", admin, async (req, res) => {
    const q = parse(
      z.object({ action: z.string().max(60).optional(), admin: z.string().max(60).optional(), q: z.string().trim().max(80).optional(), before: z.string().datetime().optional() }),
      req.query,
    );
    const filter: Record<string, unknown> = {};
    if (q.action) filter.action = q.action.endsWith(".") ? { $regex: `^${q.action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } : q.action;
    if (q.before) filter.at = { $lt: new Date(q.before) };
    if (q.admin) {
      const a = await User.findOne({ username: q.admin.toLowerCase() }).select("_id").lean();
      filter.adminId = a?._id ?? new Types.ObjectId();
    }
    if (q.q) {
      const re = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const users = await User.find({ username: re }).select("_id").lean();
      filter.$or = [{ targetUserId: { $in: users.map((u) => u._id) } }, { "details.name": re }, { "details.pair": re }];
    }
    const logs = await AdminLog.find(filter).sort({ at: -1 }).limit(100).populate("adminId", "username").populate("targetUserId", "username").lean();
    const [actions, admins] = await Promise.all([AdminLog.distinct("action"), AdminLog.distinct("adminId")]);
    const adminNames = await User.find({ _id: { $in: admins } }).select("username").lean();
    res.json({
      logs: logs.map((l) => ({
        id: String(l._id),
        at: l.at,
        action: l.action,
        admin: (l.adminId as unknown as UserDoc | null)?.username ?? null,
        target: (l.targetUserId as unknown as UserDoc | null)?.username ?? null,
        details: l.details ?? null,
      })),
      more: logs.length === 100,
      actions: actions.sort(),
      admins: adminNames.map((a) => a.username).sort(),
    });
  });
}
