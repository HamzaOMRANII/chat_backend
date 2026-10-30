import type { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { badRequest, notFound } from "../../lib/errors.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { Category } from "../../models/category.js";
import { Chat } from "../../models/chat.js";
import { Message } from "../../models/message.js";
import { User } from "../../models/user.js";
import { endLive } from "../live/service.js";
import { LiveSession, type LiveFields } from "../../models/liveSession.js";
import { endChat } from "../chats/service.js";
import type { AdminContext } from "./context.js";

/** Live chats: who, when, how long. Nothing typed is ever stored. */
export function registerLive(router: Router, { admin, log, findUser }: AdminContext) {
  router.get("/live", admin, async (req, res) => {
    const q = parse(z.object({ category: objectIdSchema.optional() }), req.query);
    const sessions = await LiveSession.find(q.category ? { categoryId: new Types.ObjectId(q.category) } : {}).sort({ invitedAt: -1 }).limit(300).lean<LiveFields[]>();
    const users = await User.find({ _id: { $in: sessions.flatMap((s) => s.participants) } }).select("username").lean();
    const names = new Map(users.map((u) => [String(u._id), u.username]));
    const categories = await Category.find().select("name").lean();
    const catNames = new Map(categories.map((c) => [String(c._id), c.name]));
    const rows = sessions.map((s) => {
      const people = s.participants.map((p) => names.get(String(p)) ?? "deleted user");
      return {
        id: String(s._id),
        label: people.join(" + "),
        status: s.status,
        category: s.categoryId ? catNames.get(String(s.categoryId)) ?? null : null,
        startedBy: names.get(String(s.createdBy)) ?? null,
        invitedAt: s.invitedAt,
        startedAt: s.startedAt ?? null,
        endedAt: s.endedAt ?? null,
        endReason: s.endReason ?? null,
        endedBy: s.endedBy ? names.get(String(s.endedBy)) ?? "admin" : null,
      };
    });
    res.json({ live: rows, now: rows.filter((r) => r.status === "active").length });
  });

  router.delete("/live/:id", admin, async (req, res) => {
    const live = await LiveSession.findById(parse(objectIdSchema, req.params.id));
    if (!live) throw notFound("Live chat not found");
    const users = await User.find({ _id: { $in: live.participants } }).select("username").lean();
    await endLive(live, "deleted_by_admin");
    await log(req, "live.ended", undefined, { pair: users.map((u) => u.username).join(" + ") });
    res.json({ ok: true });
  });

  router.delete("/users/:id/chats", admin, async (req, res) => {
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body);
    const user = await findUser(req.params.id as string);
    if (confirm !== user.username) throw badRequest("Type the username exactly to confirm.", "confirm_mismatch");
    const chats = await Chat.find({ participants: user._id, status: { $in: ["invited", "active"] } });
    const deleted = await Message.countDocuments({ chatId: { $in: chats.map((c) => c._id) } });
    for (const chat of chats) await endChat(chat, "deleted_by_admin");
    await log(req, "user.chats_deleted", user._id, { chats: chats.length, messages: deleted });
    res.json({ ok: true, chats: chats.length, deleted });
  });
}
