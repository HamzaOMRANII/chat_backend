import { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { bus } from "../../lib/events.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { Category } from "../../models/category.js";
import { StoredFile } from "../../models/file.js";
import { Group, GROUP_MAX_MEMBERS, GroupMessage, type GroupDoc } from "../../models/group.js";
import { User, type UserDoc } from "../../models/user.js";
import { presence } from "../../realtime/presence.js";
import { notify } from "../notify/service.js";
import { dropMember, systemLine } from "./service.js";
import { Friendship, pair } from "../../models/friendship.js";

const key32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "invalid key");
const sig64 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "invalid signature");
const nonce24 = z.string().regex(/^[A-Za-z0-9+/]{32}$/, "invalid nonce");
const ciphertext = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "invalid ciphertext").max(24_000, "message too long");
// A message key (32 bytes) locked for one member: nonce (24) + box (48), base64
const wrapped = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(200);

/** Mounted on /api: /api/groups/… for members. Groups themselves are made by the administrator. */
export function createGroupsRouter(config: Config) {
  const router = Router();
  router.use("/groups", requireUser(config));
  const me = (req: Request) => auth(req).user;

  async function myGroup(req: Request) {
    const group = await Group.findOne({ _id: new Types.ObjectId(parse(objectIdSchema, req.params.id)), members: me(req)._id, status: "active" });
    if (!group) throw notFound("You're not in this group.");
    return group;
  }

  async function groupsJson(user: UserDoc, groups: GroupDoc[]) {
    const people = await User.find({ _id: { $in: groups.flatMap((g) => g.members) } }).select("username identity lastSeenAt").lean();
    const byId = new Map(people.map((p) => [String(p._id), p]));
    const categories = await Category.find({ _id: { $in: groups.map((g) => g.categoryId) } }).lean();
    const unread = await GroupMessage.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { groupId: { $in: groups.map((g) => g._id) }, senderId: { $ne: user._id, $exists: true }, readBy: { $ne: user._id }, "wraps.userId": user._id } },
      { $group: { _id: "$groupId", n: { $sum: 1 } } },
    ]);
    return groups.map((g) => {
      const rules = categories.find((c) => String(c._id) === String(g.categoryId))?.rules;
      return {
        id: g.id as string,
        name: g.name,
        mode: g.mode,
        retentionMinutes: g.retentionMinutes,
        files: (rules?.files ?? "none") === "all",
        members: g.members.map((m) => {
          const p = byId.get(String(m));
          return { id: String(m), username: p?.username ?? "?", online: presence.isOnline(m), lastSeenAt: p?.lastSeenAt ?? null, identityPub: p?.identity?.signPub ?? null };
        }),
        keys: g.keys.map((k) => ({ userId: String(k.userId), version: k.version, pub: k.pub, sig: k.sig, identityPub: k.identityPub })),
        lastMessageAt: g.lastMessageAt ?? null,
        unread: unread.find((u) => String(u._id) === g.id)?.n ?? 0,
      };
    });
  }

  router.get("/groups", async (req, res) => {
    const groups = await Group.find({ members: me(req)._id, status: "active" }).sort({ lastMessageAt: -1, createdAt: -1 });
    // My own requests waiting for the administrator (or refused)
    const requests = await Group.find({ requestedBy: me(req)._id, status: { $in: ["pending", "refused"] } }).sort({ createdAt: -1 }).lean();
    const names = new Map((await User.find({ _id: { $in: requests.flatMap((r) => r.members) } }).select("username").lean()).map((u) => [String(u._id), u.username]));
    res.json({
      groups: await groupsJson(me(req), groups),
      requests: requests.map((r) => ({ id: String(r._id), name: r.name, status: r.status, members: r.members.map((m) => names.get(String(m)) ?? "?"), at: r.createdAt })),
    });
  });

  // Ask the administrator for a group with some of my contacts (up to 10 people, me included)
  router.post("/groups/requests", async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(2).max(60), memberIds: z.array(objectIdSchema).min(1).max(GROUP_MAX_MEMBERS - 1) }), req.body);
    const user = me(req);
    const ids = [...new Set(body.memberIds)].filter((id) => id !== user.id);
    for (const id of ids) {
      if (!(await Friendship.exists({ pairKey: pair(user._id, id).pairKey, status: "accepted" }))) throw badRequest("You can only add your contacts.", "not_contact");
    }
    if ((await Group.countDocuments({ requestedBy: user._id, status: "pending" })) >= 3) throw conflict("You already have 3 requests waiting. Wait for the administrator's answer.", "too_many_requests");
    const group = await Group.create({ name: body.name, status: "pending", requestedBy: user._id, members: [user._id, ...ids.map((id) => new Types.ObjectId(id))] });
    res.status(201).json({ request: { id: group.id, name: group.name, status: group.status } });
  });

  router.delete("/groups/requests/:id", async (req, res) => {
    await Group.deleteOne({ _id: parse(objectIdSchema, req.params.id), requestedBy: me(req)._id, status: { $in: ["pending", "refused"] } });
    res.json({ ok: true });
  });

  router.get("/groups/:id", async (req, res) => {
    const [group] = await groupsJson(me(req), [await myGroup(req)]);
    res.json({ group });
  });

  // This device's group key (a new version when the member moves to a new device)
  router.post("/groups/:id/keys", async (req, res) => {
    const { key } = parse(z.object({ key: z.object({ pub: key32, sig: sig64 }) }), req.body);
    const user = me(req);
    if (!user.identity?.signPub) throw conflict("Set up this device's keys first.", "no_identity");
    const group = await myGroup(req);
    const version = Math.max(0, ...group.keys.filter((k) => String(k.userId) === user.id).map((k) => k.version)) + 1;
    group.keys.push({ userId: user._id, version, pub: key.pub, sig: key.sig, identityPub: user.identity.signPub });
    await group.save();
    bus.toUsers(group.members, "group:changed", { groupId: group.id });
    res.json({ version });
  });

  router.get("/groups/:id/messages", async (req, res) => {
    const q = parse(z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
    const user = me(req);
    const group = await myGroup(req);
    const list = await GroupMessage.find({ groupId: group._id, ...(q.before ? { sentAt: { $lt: new Date(q.before) } } : {}) })
      .sort({ sentAt: -1 })
      .limit(q.limit)
      .lean();
    res.json({
      messages: list.reverse().map((m) => {
        const mine = m.wraps?.find((w) => String(w.userId) === user.id);
        return {
          id: String(m._id),
          senderId: m.senderId ? String(m.senderId) : null,
          system: m.system ? { kind: m.system.kind, userId: m.system.userId ? String(m.system.userId) : null, name: m.system.name ?? null } : null,
          // Only the parts this member can open: never other members' wraps
          ciphertext: mine ? m.ciphertext : null,
          nonce: mine ? m.nonce : null,
          senderKeyVersion: m.senderKeyVersion ?? null,
          wrap: mine ? { keyVersion: mine.keyVersion, key: mine.key } : null,
          fileId: m.fileId ? String(m.fileId) : null,
          readBy: m.readBy.length,
          recipients: (m.wraps?.length ?? 1) - 1,
          sentAt: m.sentAt,
          expiresAt: m.expiresAt,
        };
      }),
    });
  });

  router.post("/groups/:id/messages", async (req, res) => {
    const body = parse(
      z.object({
        ciphertext,
        nonce: nonce24,
        senderKeyVersion: z.number().int().min(1),
        wraps: z.array(z.object({ userId: objectIdSchema, keyVersion: z.number().int().min(1), key: wrapped })).min(1).max(20),
        fileId: objectIdSchema.optional(),
      }),
      req.body,
    );
    const user = me(req);
    const group = await myGroup(req);
    const members = new Set(group.members.map(String));
    // Locked only for current members, each with a key they really published
    for (const w of body.wraps) {
      if (!members.has(w.userId)) throw conflict("The group changed. Reload it.", "stale_members");
      if (!group.keys.some((k) => String(k.userId) === w.userId && k.version === w.keyVersion)) throw conflict("The group keys changed. Reload it.", "stale_keys");
    }
    if (!body.wraps.some((w) => w.userId === user.id)) throw badRequest("Lock it for yourself too.");
    // …and for every member who has a key, with their latest one: nobody is silently left out
    for (const m of group.members) {
      const latest = Math.max(0, ...group.keys.filter((k) => String(k.userId) === String(m)).map((k) => k.version));
      if (latest && !body.wraps.some((w) => w.userId === String(m) && w.keyVersion === latest)) throw conflict("The group keys changed. Reload it.", "stale_keys");
    }
    const file = body.fileId ? await StoredFile.findOne({ _id: body.fileId, groupId: group._id, senderId: user._id, status: "uploading" }) : null;
    if (body.fileId && (!file || file.got.length !== file.chunks)) throw conflict("The file isn't fully uploaded.", "file_incomplete");
    const sentAt = new Date();
    const message = await GroupMessage.create({
      groupId: group._id,
      senderId: user._id,
      senderKeyVersion: body.senderKeyVersion,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      wraps: body.wraps,
      fileId: file?._id,
      size: Math.floor((body.ciphertext.length * 3) / 4),
      readBy: [user._id],
      sentAt,
      expiresAt: new Date(sentAt.getTime() + (group.retentionMinutes ?? 1440) * 60_000),
    });
    if (file) {
      file.status = "ready";
      file.set("messageId", message._id);
      file.expiresAt = message.expiresAt;
      await file.save();
    }
    await Group.updateOne({ _id: group._id }, { $set: { lastMessageAt: sentAt }, $inc: { messageCount: 1 } });
    const others = group.members.filter((m) => String(m) !== user.id);
    for (const m of others) {
      const w = body.wraps.find((x) => x.userId === String(m));
      bus.toUsers([m], "group:msg", {
        groupId: group.id,
        message: { id: message.id, senderId: user.id, system: null, ciphertext: w ? body.ciphertext : null, nonce: w ? body.nonce : null, senderKeyVersion: body.senderKeyVersion, wrap: w ? { keyVersion: w.keyVersion, key: w.key } : null, fileId: file ? file.id : null, readBy: 1, recipients: body.wraps.length - 1, sentAt, expiresAt: message.expiresAt },
      });
      void notify(m, { kind: "message", title: group.name, body: `${user.username}: ${file ? "sent a file" : "new message"}`, tag: `group:${group.id}`, open: { groupId: group.id } });
    }
    res.status(201).json({ message: { id: message.id, sentAt, expiresAt: message.expiresAt, recipients: body.wraps.length - 1 } });
  });

  // This member read everything up to now
  router.post("/groups/:id/read", async (req, res) => {
    const user = me(req);
    const group = await myGroup(req);
    const unread = await GroupMessage.find({ groupId: group._id, readBy: { $ne: user._id }, "wraps.userId": user._id }).select("_id senderId").lean();
    if (unread.length) {
      await GroupMessage.updateMany({ _id: { $in: unread.map((m) => m._id) } }, { $addToSet: { readBy: user._id } });
      bus.toUsers(group.members, "group:read", { groupId: group.id, by: user.id, ids: unread.map((m) => String(m._id)) });
    }
    res.json({ read: unread.length });
  });

  router.post("/groups/:id/leave", async (req, res) => {
    const user = me(req);
    const group = await myGroup(req);
    await dropMember(group, user._id);
    await systemLine(group, "left", user);
    res.json({ ok: true });
  });

  return router;
}
