import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { clientDeviceSchema, deviceSnapshot, type DeviceSnapshot } from "../../lib/device.js";
import { badRequest, conflict, locked, notFound, unauthorized } from "../../lib/errors.js";
import type { Mailer } from "../../lib/mailer.js";
import { hashSecret, numericCode, verifySecret } from "../../lib/secrets.js";
import { codeSchema, objectIdSchema, parse, usernameSchema } from "../../lib/validate.js";
import { auth, requireAdmin } from "../../middleware/auth.js";
import { AdminLog } from "../../models/adminLog.js";
import { Block } from "../../models/block.js";
import { Category, CHAT_MODES } from "../../models/category.js";
import { Friendship, otherUserId } from "../../models/friendship.js";
import { Invite } from "../../models/invite.js";
import { Lookup } from "../../models/lookup.js";
import { DeviceEvent } from "../../models/deviceEvent.js";
import { Session } from "../../models/session.js";
import { User, USER_STATUSES, type UserDoc } from "../../models/user.js";
import { bus } from "../../lib/events.js";
import { presence } from "../../realtime/presence.js";
import { effectiveCategoryId, ensurePersonalId, relatedUserIds, sharedCategoryIds } from "../contacts/service.js";
import { checkCode, openChallenge, sendCodeChallenge } from "../auth/routes.js";
import { clearFailures, clearToken, deliverToken, isLocked, recordEvent, registerFailure, revokeAllSessions, revokeSession, startSession } from "../auth/sessions.js";

const RESET_CODE_HOURS = 24;

const rulesSchema = z.object({
  modes: z.array(z.enum(CHAT_MODES)).min(1, "allow at least one chat mode"),
  maxRetentionDays: z.number().int().min(0).max(7),
  files: z.enum(["all", "p2p", "none"]),
  export: z.boolean(),
  calls: z.enum(["none", "voice", "video"]),
});

export function createAdminRouter(config: Config, mailer: Mailer) {
  const router = Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  const admin = requireAdmin(config);

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

  // ---------- Admin sign-in: password, then a code sent to the admin's email ----------
  router.post("/auth/login", authLimiter, async (req, res) => {
    const body = parse(z.object({ username: usernameSchema, password: z.string().min(1).max(200), device: z.unknown() }), req.body);
    const d = deviceSnapshot(req, parse(clientDeviceSchema, body.device));
    const user = await User.findOne({ username: body.username, role: "admin", status: "approved" }).select("+passwordHash");
    if (user && isLocked(user)) throw locked("Too many wrong attempts. Try again in 30 minutes.");
    if (!user || !(await verifySecret(user.passwordHash, body.password))) {
      if (user) await registerFailure(user, d);
      throw unauthorized("Wrong username or password.", "wrong_credentials");
    }
    res.json(await sendCodeChallenge(mailer, user, "admin-login", d));
  });

  router.post("/auth/verify-code", authLimiter, async (req, res) => {
    const body = parse(z.object({ challengeId: objectIdSchema, code: codeSchema }), req.body);
    const { challenge, user } = await openChallenge(body.challengeId, "admin-login");
    await checkCode(challenge, user, body.code);
    await challenge.deleteOne();
    await clearFailures(user);
    const d = challenge.device as DeviceSnapshot;
    const { token } = await startSession(config, user, "admin", d);
    await recordEvent(user._id, "login", d);
    deliverToken(req, res, config, "admin", token);
    res.json({ admin: { id: user.id, username: user.username } });
  });

  router.post("/auth/logout", admin, async (req, res) => {
    await revokeSession(auth(req).session, "logout");
    clearToken(res, config, "admin");
    res.json({ ok: true });
  });

  router.get("/auth/me", admin, (req, res) => {
    res.json({ admin: { id: auth(req).user.id, username: auth(req).user.username } });
  });

  // ---------- Users ----------
  router.get("/users", admin, async (req, res) => {
    const q = parse(
      z.object({ status: z.enum(USER_STATUSES).optional(), search: z.string().trim().max(80).optional(), category: objectIdSchema.optional() }),
      req.query,
    );
    const filter: Record<string, unknown> = { role: "user" };
    if (q.status) filter.status = q.status;
    if (q.category) filter.categoryIds = new Types.ObjectId(q.category);
    if (q.search) {
      const re = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ username: re }, { email: re }];
    }
    const users = await User.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    const ids = users.map((u) => u._id);
    // Latest event per user: sign-up device for pending users, last sign-in for the others
    const latest = await DeviceEvent.aggregate([
      { $match: { userId: { $in: ids }, type: { $in: ["signup", "login"] } } },
      { $sort: { at: -1 } },
      { $group: { _id: "$userId", type: { $first: "$type" }, at: { $first: "$at" }, deviceName: { $first: "$deviceName" }, city: { $first: "$city" }, country: { $first: "$country" }, ip: { $first: "$ip" } } },
    ]);
    const byUser = new Map(latest.map((e) => [String(e._id), e]));
    const counts = await User.aggregate([{ $match: { role: "user" } }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
    res.json({
      counts: Object.fromEntries(USER_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
      users: users.map((u) => ({
        id: String(u._id),
        username: u.username,
        email: u.email,
        status: u.status,
        categoryIds: u.categoryIds.map(String),
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt,
        lastDevice: byUser.get(String(u._id)) ?? null,
      })),
    });
  });

  router.get("/users/:id", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    const [events, devices, liveSession] = await Promise.all([
      DeviceEvent.find({ userId: user._id }).sort({ at: -1 }).limit(300).lean(),
      DeviceEvent.aggregate([
        { $match: { userId: user._id, deviceId: { $ne: null } } },
        { $sort: { at: 1 } },
        {
          $group: {
            _id: "$deviceId",
            name: { $last: "$deviceName" },
            platform: { $last: "$platform" },
            model: { $last: "$model" },
            manufacturer: { $last: "$manufacturer" },
            osVersion: { $last: "$osVersion" },
            os: { $last: "$os" },
            browser: { $last: "$browser" },
            appVersion: { $last: "$appVersion" },
            screen: { $last: "$screen" },
            language: { $last: "$language" },
            timezone: { $last: "$timezone" },
            network: { $last: "$network" },
            firstSeen: { $first: "$at" },
            lastSeen: { $last: "$at" },
            logins: { $sum: { $cond: [{ $eq: ["$type", "login"] }, 1, 0] } },
          },
        },
        { $sort: { lastSeen: -1 } },
      ]),
      Session.findOne({ userId: user._id, kind: "user", revokedAt: null, expiresAt: { $gt: new Date() } }).lean(),
    ]);
    const approvedBy = user.approvedBy ? await User.findById(user.approvedBy).select("username").lean() : null;
    res.json({
      user: { ...user.toJSON(), id: user.id, approvedBy: approvedBy?.username ?? null, locked: isLocked(user) },
      currentDeviceId: liveSession?.device?.deviceId ?? null,
      devices: devices.map(({ _id, ...d }) => ({ deviceId: _id, ...d })),
      events,
    });
  });

  router.post("/users/:id/approve", admin, async (req, res) => {
    const { categoryIds } = parse(z.object({ categoryIds: z.array(objectIdSchema).min(1, "pick at least one category") }), req.body);
    const user = await findUser(req.params.id as string);
    if (user.status !== "pending" && user.status !== "rejected") throw conflict("Only pending or rejected requests can be approved.");
    user.categoryIds = await validCategoryIds(categoryIds);
    user.status = "approved";
    user.approvedAt = new Date();
    user.approvedBy = auth(req).user._id;
    user.rejectedAt = undefined;
    await user.save();
    await ensurePersonalId(user);
    await log(req, "user.approved", user._id, { categoryIds });
    res.json({ ok: true });
  });

  router.post("/users/:id/reject", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    if (user.status !== "pending") throw conflict("Only pending requests can be rejected.");
    user.status = "rejected";
    user.rejectedAt = new Date();
    await user.save();
    await log(req, "user.rejected", user._id);
    res.json({ ok: true });
  });

  router.post("/users/:id/suspend", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    if (user.status !== "approved") throw conflict("Only approved accounts can be suspended.");
    user.status = "suspended";
    user.suspendedAt = new Date();
    await user.save();
    await revokeAllSessions(user._id, "suspended");
    bus.contactsChanged(await relatedUserIds(user._id));
    await log(req, "user.suspended", user._id);
    res.json({ ok: true });
  });

  router.post("/users/:id/reactivate", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    if (user.status !== "suspended") throw conflict("Only suspended accounts can be reactivated.");
    user.status = "approved";
    user.suspendedAt = undefined;
    await user.save();
    bus.contactsChanged(await relatedUserIds(user._id));
    await log(req, "user.reactivated", user._id);
    res.json({ ok: true });
  });

  router.post("/users/:id/force-logout", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    await revokeAllSessions(user._id, "admin");
    await log(req, "user.force_logout", user._id);
    res.json({ ok: true });
  });

  router.post("/users/:id/unlock", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    await clearFailures(user);
    await log(req, "user.unlocked", user._id);
    res.json({ ok: true });
  });

  // Lost email AND passcode: a one-time 10-digit code, shown to the admin once, valid 24 h.
  router.post("/users/:id/reset-access", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    if (user.status !== "approved") throw conflict("Only approved accounts can be reset.");
    const code = numericCode(10);
    user.adminResetHash = await hashSecret(code);
    user.adminResetExpiresAt = new Date(Date.now() + RESET_CODE_HOURS * 3600_000);
    await user.save();
    await revokeAllSessions(user._id, "admin");
    await log(req, "user.reset_access", user._id);
    res.json({ code, expiresAt: user.adminResetExpiresAt });
  });

  router.put("/users/:id/categories", admin, async (req, res) => {
    const { categoryIds } = parse(z.object({ categoryIds: z.array(objectIdSchema).min(1, "keep at least one category") }), req.body);
    const user = await findUser(req.params.id as string);
    const before = user.categoryIds.map(String);
    user.categoryIds = await validCategoryIds(categoryIds);
    await user.save();
    // Contacts who no longer share a category are paused (hidden from both), not deleted: see the Contacts tab.
    bus.contactsChanged([user.id, ...(await relatedUserIds(user._id))]);
    await log(req, "user.categories_changed", user._id, { before, after: categoryIds });
    res.json({ ok: true });
  });

  // Typing the username confirms; deletes the account and ends its sessions. Security log stays 90 days.
  router.delete("/users/:id", admin, async (req, res) => {
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body);
    const user = await findUser(req.params.id as string);
    if (confirm !== user.username) throw badRequest("Type the username exactly to confirm.", "confirm_mismatch");
    await revokeAllSessions(user._id, "deleted");
    const related = await relatedUserIds(user._id);
    await Promise.all([
      Friendship.deleteMany({ $or: [{ userA: user._id }, { userB: user._id }] }),
      Block.deleteMany({ $or: [{ blockerId: user._id }, { blockedId: user._id }] }),
      Invite.deleteMany({ ownerId: user._id }),
      Lookup.deleteMany({ userId: user._id }),
    ]);
    await user.deleteOne();
    bus.contactsChanged(related);
    await log(req, "user.deleted", user._id, { username: user.username, email: user.email });
    res.json({ ok: true });
  });

  // ---------- Contacts of a user ----------
  router.get("/users/:id/contacts", admin, async (req, res) => {
    const user = await findUser(req.params.id as string);
    const friendships = await Friendship.find({ $or: [{ userA: user._id }, { userB: user._id }] }).sort({ createdAt: -1 }).lean();
    const others = await User.find({ _id: { $in: friendships.map((f) => otherUserId(f, user._id)) } })
      .select("username status categoryIds lastSeenAt")
      .lean();
    const byId = new Map(others.map((u) => [String(u._id), u]));
    const rows = await Promise.all(
      friendships.map(async (f) => {
        const other = byId.get(String(otherUserId(f, user._id)));
        if (!other) return null;
        const shared = sharedCategoryIds(user, other);
        return {
          id: String(f._id),
          status: f.status,
          direction: String(f.requestedBy) === user.id ? "sent" : "received",
          via: f.via,
          createdAt: f.createdAt,
          acceptedAt: f.acceptedAt ?? null,
          user: { id: String(other._id), username: other.username, status: other.status, online: presence.isOnline(other._id), lastSeenAt: other.lastSeenAt ?? null },
          sharedCategoryIds: shared,
          categoryId: await effectiveCategoryId(shared, f.categoryId),
          categoryChosen: !!f.categoryId && shared.includes(String(f.categoryId)),
          paused: !shared.length || other.status !== "approved" || user.status !== "approved",
        };
      }),
    );
    const list = rows.filter((r) => r !== null);
    res.json({ personalId: user.personalId ?? null, contacts: list.filter((r) => r.status === "accepted"), requests: list.filter((r) => r.status === "pending") });
  });

  // Which shared category's rules apply to this pair.
  router.put("/friendships/:id/category", admin, async (req, res) => {
    const { categoryId } = parse(z.object({ categoryId: objectIdSchema }), req.body);
    const f = await Friendship.findById(parse(objectIdSchema, req.params.id));
    if (!f) throw notFound("Contact not found");
    const [a, b] = await Promise.all([User.findById(f.userA).lean(), User.findById(f.userB).lean()]);
    if (!a || !b || !sharedCategoryIds(a, b).includes(categoryId)) throw badRequest("Both people must be in this category.", "not_shared");
    f.categoryId = new Types.ObjectId(categoryId);
    await f.save();
    await log(req, "friendship.category_changed", undefined, { pair: `${a.username} + ${b.username}`, categoryId });
    res.json({ ok: true });
  });

  router.delete("/friendships/:id", admin, async (req, res) => {
    const f = await Friendship.findById(parse(objectIdSchema, req.params.id));
    if (!f) throw notFound("Contact not found");
    const [a, b] = await Promise.all([User.findById(f.userA).select("username").lean(), User.findById(f.userB).select("username").lean()]);
    await f.deleteOne();
    bus.contactsChanged([f.userA, f.userB]);
    await log(req, "friendship.ended", undefined, { pair: `${a?.username ?? "?"} + ${b?.username ?? "?"}` });
    res.json({ ok: true });
  });

  // ---------- Categories ----------
  router.get("/categories", admin, async (_req, res) => {
    const [categories, members] = await Promise.all([
      Category.find().sort({ order: 1 }).lean(),
      User.aggregate([{ $match: { role: "user", status: { $in: ["approved", "suspended"] } } }, { $unwind: "$categoryIds" }, { $group: { _id: "$categoryIds", n: { $sum: 1 } } }]),
    ]);
    const count = new Map(members.map((m) => [String(m._id), m.n]));
    res.json({ categories: categories.map((c) => ({ id: String(c._id), name: c.name, order: c.order, rules: c.rules, members: count.get(String(c._id)) ?? 0 })) });
  });

  router.get("/categories/:id/members", admin, async (req, res) => {
    const id = parse(objectIdSchema, req.params.id);
    const users = await User.find({ role: "user", categoryIds: id }).select("username status").sort({ username: 1 }).lean();
    res.json({ members: users.map((u) => ({ id: String(u._id), username: u.username, status: u.status })) });
  });

  router.post("/categories", admin, async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(40), rules: rulesSchema }), req.body);
    if (await Category.exists({ name: body.name })) throw conflict("A category with this name exists.");
    const last = await Category.findOne().sort({ order: -1 }).lean();
    const category = await Category.create({ ...body, order: (last?.order ?? 0) + 1 });
    await log(req, "category.created", undefined, { name: body.name });
    res.status(201).json({ id: category.id });
  });

  router.patch("/categories/:id", admin, async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), rules: rulesSchema.optional() }), req.body);
    const category = await Category.findById(parse(objectIdSchema, req.params.id));
    if (!category) throw notFound("Category not found");
    if (body.name && body.name !== category.name && (await Category.exists({ name: body.name }))) throw conflict("A category with this name exists.");
    if (body.name) category.name = body.name;
    if (body.rules) category.set("rules", body.rules);
    await category.save();
    // Existing chats that break tighter rules are ended here once chats exist (M3).
    await log(req, "category.updated", undefined, { id: category.id, ...body });
    res.json({ ok: true });
  });

  router.post("/categories/reorder", admin, async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(objectIdSchema).min(1) }), req.body);
    if ((await Category.countDocuments()) !== ids.length || (await Category.countDocuments({ _id: { $in: ids } })) !== ids.length) {
      throw badRequest("Send every category exactly once.");
    }
    await Category.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { order: i + 1 } } })));
    await log(req, "category.reordered", undefined, { ids });
    res.json({ ok: true });
  });

  router.delete("/categories/:id", admin, async (req, res) => {
    const id = parse(objectIdSchema, req.params.id);
    if (await User.exists({ categoryIds: id })) throw conflict("Remove everyone from this category first.", "category_in_use");
    const category = await Category.findByIdAndDelete(id);
    if (!category) throw notFound("Category not found");
    await log(req, "category.deleted", undefined, { name: category.name });
    res.json({ ok: true });
  });

  // ---------- Activity log ----------
  router.get("/logs", admin, async (_req, res) => {
    const logs = await AdminLog.find().sort({ at: -1 }).limit(300).populate("adminId", "username").populate("targetUserId", "username").lean();
    res.json({
      logs: logs.map((l) => ({
        id: String(l._id),
        at: l.at,
        action: l.action,
        admin: (l.adminId as unknown as UserDoc | null)?.username ?? null,
        target: (l.targetUserId as unknown as UserDoc | null)?.username ?? null,
        details: l.details ?? null,
      })),
    });
  });

  return router;
}
