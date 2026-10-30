import type { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { badRequest, notFound } from "../../lib/errors.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { Category } from "../../models/category.js";
import { Chat, type ChatFields } from "../../models/chat.js";
import { Message } from "../../models/message.js";
import { User } from "../../models/user.js";
import { endLive } from "../live/service.js";
import { StoredFile } from "../../models/file.js";
import { ExportRequest } from "../../models/exportRequest.js";
import { deleteFiles } from "../files/service.js";
import { LiveSession } from "../../models/liveSession.js";
import { endChat } from "../chats/service.js";
import type { AdminContext } from "./context.js";

/** Chats: metadata only, content is end-to-end encrypted. */
export function registerChats(router: Router, { admin, log }: AdminContext) {
  async function chatRows(chats: ChatFields[]) {
    const users = await User.find({ _id: { $in: chats.flatMap((c) => c.participants) } })
      .select("username")
      .lean();
    const names = new Map(users.map((u) => [String(u._id), u.username]));
    const categories = await Category.find().select("name").lean();
    const catNames = new Map(categories.map((c) => [String(c._id), c.name]));
    const stats = await Message.aggregate<{ _id: Types.ObjectId; n: number; bytes: number; oldest: Date }>([
      { $match: { chatId: { $in: chats.map((c) => c._id) } } },
      { $group: { _id: "$chatId", n: { $sum: 1 }, bytes: { $sum: "$size" }, oldest: { $min: "$expiresAt" } } },
    ]);
    const statsBy = new Map(stats.map((st) => [String(st._id), st]));
    return chats.map((c) => {
      const people = c.participants.map((p) => ({ id: String(p), username: names.get(String(p)) ?? "deleted user" }));
      const st = statsBy.get(String(c._id));
      return {
        id: String(c._id),
        people,
        label: people.map((p) => p.username).join(" + "),
        mode: c.mode,
        retentionMinutes: c.retentionMinutes,
        status: c.status,
        category: c.categoryId ? (catNames.get(String(c.categoryId)) ?? null) : null,
        startedBy: names.get(String(c.createdBy)) ?? null,
        invitedAt: c.invitedAt,
        acceptedAt: c.acceptedAt ?? null,
        endedAt: c.endedAt ?? null,
        endReason: c.endReason ?? null,
        endedBy: c.endedBy ? (names.get(String(c.endedBy)) ?? "admin") : null,
        lastMessageAt: c.lastMessageAt ?? null,
        messagesSent: c.messageCount ?? 0,
        stored: { count: st?.n ?? 0, bytes: st?.bytes ?? 0, nextExpiry: st?.oldest ?? null },
      };
    });
  }

  router.get("/chats", admin, async (req, res) => {
    const q = parse(
      z.object({
        status: z.enum(["all", "active", "invited", "ended"]).default("active"),
        search: z.string().trim().max(80).optional(),
        user: objectIdSchema.optional(),
        category: objectIdSchema.optional(),
      }),
      req.query,
    );
    const filter: Record<string, unknown> = q.status === "all" ? {} : { status: q.status };
    if (q.category) filter.categoryId = new Types.ObjectId(q.category);
    if (q.user) filter.participants = new Types.ObjectId(q.user);
    if (q.search) {
      const re = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const ids = await User.find({ username: re }).select("_id").lean();
      filter.participants = { $in: ids.map((u) => u._id) };
    }
    const chats = await Chat.find(filter).sort({ lastMessageAt: -1, invitedAt: -1 }).limit(300).lean<ChatFields[]>();
    const counts = await Chat.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    res.json({
      counts: Object.fromEntries(["active", "invited", "ended"].map((st) => [st, counts.find((c) => c._id === st)?.n ?? 0])),
      chats: await chatRows(chats),
    });
  });

  router.get("/chats/:id", admin, async (req, res) => {
    const chat = await Chat.findById(parse(objectIdSchema, req.params.id)).lean<ChatFields>();
    if (!chat) throw notFound("Chat not found");
    const [row] = await chatRows([chat]);
    const messages = await Message.find({ chatId: chat._id })
      .sort({ sentAt: -1 })
      .limit(30)
      .select("senderId recipientId size sentAt deliveredAt readAt expiresAt")
      .lean();
    const names = new Map(row!.people.map((p) => [p.id, p.username]));
    const exports = await ExportRequest.find({ chatId: chat._id }).sort({ requestedAt: -1 }).limit(20).lean();
    res.json({
      chat: row,
      // Who asked, the answer, when it was saved: never what was in it
      exports: exports.map((e) => ({
        id: String(e._id),
        by: names.get(String(e.requestedBy)) ?? "?",
        approver: names.get(String(e.approverId)) ?? "?",
        messages: e.messages,
        media: e.media,
        period: e.period,
        status: e.status,
        requestedAt: e.requestedAt,
        answeredAt: e.answeredAt ?? null,
        downloadedAt: e.downloadedAt ?? null,
      })),
      // Never the ciphertext, let alone content: who, when, how big, receipts
      messages: messages.map((m) => ({
        id: String(m._id),
        from: names.get(String(m.senderId)) ?? "?",
        to: names.get(String(m.recipientId)) ?? "?",
        size: m.size,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt ?? null,
        readAt: m.readAt ?? null,
        expiresAt: m.expiresAt,
      })),
    });
  });

  // Deletes every stored message and ends the chat for both. Typing "a + b" confirms.
  // Removes chats for good: open ones end first (messages deleted for both), then every trace goes: the chat record,
  // its files on disk, its exports. Live chats too. Typing "DELETE" confirms. Frees database and disk space.
  router.post("/chats/purge", admin, async (req, res) => {
    const body = parse(
      z.object({
        confirm: z.literal("DELETE", { message: 'Type "DELETE" to confirm.' }),
        ids: z.array(objectIdSchema).max(5000).default([]),
        liveIds: z.array(objectIdSchema).max(5000).default([]),
        all: z.object({ category: objectIdSchema.optional() }).optional(),
      }),
      req.body,
    );
    const byCategory = body.all?.category ? { categoryId: new Types.ObjectId(body.all.category) } : {};
    const chats = await Chat.find(body.all ? byCategory : { _id: { $in: body.ids } });
    const lives = await LiveSession.find(body.all ? byCategory : { _id: { $in: body.liveIds } });
    let messages = 0;
    let bytes = 0;
    for (const chat of chats) {
      messages += await Message.countDocuments({ chatId: chat._id });
      if (chat.status !== "ended") await endChat(chat, "deleted_by_admin");
      const files = await StoredFile.find({ chatId: chat._id });
      bytes += files.filter((f) => f.status !== "deleted").reduce((a, f) => a + f.size, 0);
      await deleteFiles(files, "removed_by_admin");
      await Promise.all([
        Message.deleteMany({ chatId: chat._id }),
        StoredFile.deleteMany({ chatId: chat._id }),
        ExportRequest.deleteMany({ chatId: chat._id }),
      ]);
      await Chat.deleteOne({ _id: chat._id });
    }
    for (const live of lives) {
      if (live.status !== "ended") await endLive(live, "deleted_by_admin");
      await LiveSession.deleteOne({ _id: live._id });
    }
    await log(req, "chats.purged", undefined, { chats: chats.length, live: lives.length, messages, bytes, all: Boolean(body.all) });
    res.json({ chats: chats.length, live: lives.length, messages, bytes });
  });

  router.delete("/chats/:id", admin, async (req, res) => {
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body);
    const chat = await Chat.findById(parse(objectIdSchema, req.params.id));
    if (!chat) throw notFound("Chat not found");
    const [row] = await chatRows([chat.toObject() as ChatFields]);
    if (confirm !== row!.label) throw badRequest(`Type "${row!.label}" exactly to confirm.`, "confirm_mismatch");
    const deleted = await Message.countDocuments({ chatId: chat._id });
    await endChat(chat, "deleted_by_admin");
    await log(req, "chat.deleted", undefined, { pair: row!.label, messages: deleted });
    res.json({ ok: true, deleted });
  });
}
