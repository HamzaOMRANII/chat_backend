import type { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { badRequest, conflict, } from "../../lib/errors.js";
import { hashSecret, numericCode } from "../../lib/secrets.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth } from "../../middleware/auth.js";
import { Block } from "../../models/block.js";
import { Friendship } from "../../models/friendship.js";
import { Invite } from "../../models/invite.js";
import { Lookup } from "../../models/lookup.js";
import { DeviceEvent } from "../../models/deviceEvent.js";
import { Session } from "../../models/session.js";
import { User, USER_STATUSES } from "../../models/user.js";
import { bus } from "../../lib/events.js";
import { ensurePersonalId, relatedUserIds } from "../contacts/service.js";
import { reconcileChats } from "../chats/service.js";
import { clearFailures, isLocked, revokeAllSessions } from "../auth/sessions.js";
import type { AdminContext } from "./context.js";

const RESET_CODE_HOURS = 24;

/** Users: list, details, approval, suspension, locks, access resets, categories, deletion. */
export function registerUsers(router: Router, { admin, log, findUser, validCategoryIds }: AdminContext) {
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
    await reconcileChats([user._id]);
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
    user.secureCodeHash = undefined;
    user.secureCodeSetAt = undefined;
    await user.save();
    await revokeAllSessions(user._id, "admin");
    await log(req, "user.reset_access", user._id);
    res.json({ code, expiresAt: user.adminResetExpiresAt });
  });

  // Secure code (sign-in without the emailed code): on by default, the administrator can switch it off.
  // Switching off keeps the code but refuses it; the user is told in Settings.
  router.put("/users/:id/secure-code", admin, async (req, res) => {
    const { allowed } = parse(z.object({ allowed: z.boolean() }), req.body);
    const user = await findUser(req.params.id as string);
    user.secureCodeDisabled = !allowed;
    await user.save();
    await log(req, allowed ? "user.secure_code_allowed" : "user.secure_code_disabled", user._id);
    res.json({ allowed });
  });

  router.put("/users/:id/categories", admin, async (req, res) => {
    const { categoryIds } = parse(z.object({ categoryIds: z.array(objectIdSchema).min(1, "keep at least one category") }), req.body);
    const user = await findUser(req.params.id as string);
    const before = user.categoryIds.map(String);
    user.categoryIds = await validCategoryIds(categoryIds);
    await user.save();
    // Contacts who no longer share a category are paused (hidden from both), not deleted: see the Contacts tab.
    const related = await relatedUserIds(user._id);
    await reconcileChats([user._id, ...related]);
    bus.contactsChanged([user.id, ...related]);
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
    await reconcileChats([user._id]); // no contacts left: every chat ends and its messages are deleted
    await user.deleteOne();
    bus.contactsChanged(related);
    await log(req, "user.deleted", user._id, { username: user.username, email: user.email });
    res.json({ ok: true });
  });
}
