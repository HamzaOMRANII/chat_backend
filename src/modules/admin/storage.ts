import type { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { badRequest } from "../../lib/errors.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { User } from "../../models/user.js";
import { bus } from "../../lib/events.js";
import { StoredFile } from "../../models/file.js";
import { cleanupFiles, deleteFiles, disk, DISK_LIMIT, lastCleanupResult, QUOTA_BYTES } from "../files/service.js";
import { notify } from "../notify/service.js";
import type { AdminContext } from "./context.js";

/** Storage: encrypted files, sizes and dates only. */
export function registerStorage(router: Router, { admin, log, findUser }: AdminContext) {
  router.get("/storage", admin, async (_req, res) => {
    const live = { status: { $in: ["uploading", "ready"] } };
    const perUser = await StoredFile.aggregate<{ _id: Types.ObjectId; n: number; bytes: number; next: Date }>([
      { $match: live },
      { $group: { _id: "$senderId", n: { $sum: 1 }, bytes: { $sum: "$size" }, next: { $min: "$expiresAt" } } },
    ]);
    const users = await User.find({ $or: [{ _id: { $in: perUser.map((u) => u._id) } }, { "mediaRequest.deadline": { $ne: null } }] })
      .select("username mediaRequest")
      .lean();
    const chats = await StoredFile.distinct("chatId", { status: { $in: ["uploading", "ready"] } });
    const d = await disk();
    const rows = users.map((u) => {
      const st = perUser.find((p) => String(p._id) === String(u._id));
      return { id: String(u._id), username: u.username, files: st?.n ?? 0, bytes: st?.bytes ?? 0, nextExpiry: st?.next ?? null, request: u.mediaRequest?.deadline ?? null };
    });
    res.json({
      files: rows.reduce((a, r) => a + r.files, 0),
      bytes: rows.reduce((a, r) => a + r.bytes, 0),
      chats: chats.length,
      quota: QUOTA_BYTES,
      disk: { used: d.used, total: d.total, ratio: d.ratio, limit: DISK_LIMIT },
      lastCleanup: lastCleanupResult(),
      users: rows.sort((a, b) => b.bytes - a.bytes),
    });
  });

  router.get("/storage/users/:id", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    const files = await StoredFile.find({ senderId: user._id, status: { $in: ["uploading", "ready"] } }).sort({ size: -1 }).lean();
    const others = await User.find({ _id: { $in: files.map((f) => f.recipientId) } }).select("username").lean();
    const names = new Map(others.map((o) => [String(o._id), o.username]));
    res.json({
      user: { id: user.id, username: user.username, request: user.mediaRequest?.deadline ?? null },
      quota: QUOTA_BYTES,
      files: files.map((f) => ({ id: String(f._id), kind: f.kind, size: f.size, to: names.get(String(f.recipientId)) ?? "?", status: f.status, createdAt: (f as { createdAt?: Date }).createdAt ?? null, expiresAt: f.expiresAt })),
    });
  });

  // "Download your media before <deadline>": notification now, reminders 24 h and 1 h before, then deleted
  router.post("/storage/users/:id/request", admin, async (req, res) => {
    const { hours } = parse(z.object({ hours: z.union([z.literal(24), z.literal(72), z.literal(168)]) }), req.body);
    const user = await findUser(req.params.id as string);
    const deadline = new Date(Date.now() + hours * 3600_000);
    user.set("mediaRequest", { deadline, requestedAt: new Date(), reminded: [] });
    await user.save();
    const when = deadline.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    void notify(user._id, { kind: "media_request", title: "Download your media", body: `The administrator is freeing space: your files will be deleted on ${when} (UTC).`, tag: "media-request", open: { media: true } });
    bus.toUsers([user._id], "media:request", { deadline });
    await log(req, "storage.request", user._id, { hours });
    res.json({ deadline });
  });

  router.delete("/storage/users/:id/request", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    user.set("mediaRequest", undefined);
    await user.save();
    bus.toUsers([user._id], "media:request", { deadline: null });
    await log(req, "storage.request_cancelled", user._id);
    res.json({ ok: true });
  });

  // Deletes files now (some, or all of a user's); the chats show "removed by an administrator"
  router.post("/storage/delete", admin, async (req, res) => {
    const body = parse(z.object({ ids: z.array(objectIdSchema).max(1000).optional(), userId: objectIdSchema.optional() }), req.body);
    if (!body.ids?.length && !body.userId) throw badRequest("Choose the files to delete");
    const filter = body.userId ? { senderId: new Types.ObjectId(body.userId) } : { _id: { $in: body.ids } };
    const files = await StoredFile.find({ ...filter, status: { $in: ["uploading", "ready"] } });
    const bytes = files.reduce((a, f) => a + f.size, 0);
    await deleteFiles(files, "removed_by_admin");
    await log(req, "storage.deleted", body.userId, { files: files.length, bytes });
    res.json({ deleted: files.length, bytes });
  });

  router.post("/storage/cleanup", admin, async (req, res) => {
    const result = await cleanupFiles();
    await log(req, "storage.cleanup", undefined, result);
    res.json(result);
  });
}
