import type { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { badRequest, notFound } from "../../lib/errors.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { Friendship, otherUserId } from "../../models/friendship.js";
import { User } from "../../models/user.js";
import { bus } from "../../lib/events.js";
import { presence } from "../../realtime/presence.js";
import { effectiveCategoryId, sharedCategoryIds } from "../contacts/service.js";
import { reconcileChats } from "../chats/service.js";
import type { AdminContext } from "./context.js";

/** Contacts of a user: friendships, their category, removal. */
export function registerContacts(router: Router, { admin, log, findUser }: AdminContext) {
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
    await reconcileChats([f.userA, f.userB]);
    await log(req, "friendship.category_changed", undefined, { pair: `${a.username} + ${b.username}`, categoryId });
    res.json({ ok: true });
  });

  router.delete("/friendships/:id", admin, async (req, res) => {
    const f = await Friendship.findById(parse(objectIdSchema, req.params.id));
    if (!f) throw notFound("Contact not found");
    const [a, b] = await Promise.all([User.findById(f.userA).select("username").lean(), User.findById(f.userB).select("username").lean()]);
    await f.deleteOne();
    await reconcileChats([f.userA, f.userB]);
    bus.contactsChanged([f.userA, f.userB]);
    await log(req, "friendship.ended", undefined, { pair: `${a?.username ?? "?"} + ${b?.username ?? "?"}` });
    res.json({ ok: true });
  });
}
