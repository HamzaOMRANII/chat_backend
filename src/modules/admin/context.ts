import type { Request, RequestHandler } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { badRequest, notFound } from "../../lib/errors.js";
import type { Mailer } from "../../lib/mailer.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth, requireAdmin } from "../../middleware/auth.js";
import { AdminLog } from "../../models/adminLog.js";
import { Category, CHAT_MODES } from "../../models/category.js";
import { User } from "../../models/user.js";

/** A category's chat rules, as the backoffice sends them (categories and restore). */
export const rulesSchema = z.object({
  modes: z.array(z.enum(CHAT_MODES)).min(1, "allow at least one chat mode"),
  maxRetentionDays: z.number().int().min(0).max(7),
  files: z.enum(["all", "p2p", "none"]),
  export: z.boolean(),
  calls: z.enum(["none", "voice", "video"]),
});

/** What every admin section gets: the admin-only guard and the shared helpers. */
export type AdminContext = ReturnType<typeof createAdminContext>;

export function createAdminContext(config: Config, mailer: Mailer) {
  const admin: RequestHandler = requireAdmin(config);

  async function log(req: Request, action: string, targetUserId?: Types.ObjectId | string, details?: Record<string, unknown>) {
    await AdminLog.create({ adminId: auth(req).user._id, action, targetUserId, details });
  }
  async function findUser(id: string) {
    const user = await User.findOne({ _id: parse(objectIdSchema, id), role: "user" });
    if (!user) throw notFound("User not found");
    return user;
  }
  async function validCategoryIds(ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await Category.countDocuments({ _id: { $in: unique } });
    if (found !== unique.length) throw badRequest("Unknown category", "unknown_category");
    return unique.map((id) => new Types.ObjectId(id));
  }

  return { config, mailer, admin, log, findUser, validCategoryIds };
}
