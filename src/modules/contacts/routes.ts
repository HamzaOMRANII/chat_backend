import { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { conflict, HttpError, notFound } from "../../lib/errors.js";
import { bus } from "../../lib/events.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { Block } from "../../models/block.js";
import { Friendship, pair } from "../../models/friendship.js";
import { Invite } from "../../models/invite.js";
import { Lookup } from "../../models/lookup.js";
import { User } from "../../models/user.js";
import { reconcileChats } from "../chats/service.js";
import {
  canConnect,
  contactJson,
  contactsView,
  ensurePersonalId,
  newInviteCode,
  newPersonalId,
  normalizeInviteCode,
  normalizePersonalId,
} from "./service.js";

export const SEARCHES_PER_HOUR = 10;
const INVITE_HOURS = 24;

export function createContactsRouter(config: Config) {
  const router = Router();
  router.use(requireUser(config));

  const me = (req: Request) => auth(req).user;

  async function searchesLeft(userId: Types.ObjectId) {
    const used = await Lookup.countDocuments({ userId, at: { $gt: new Date(Date.now() - 3600_000) } });
    return Math.max(0, SEARCHES_PER_HOUR - used);
  }

  // ---------- My ID and invite code ----------
  router.get("/me", async (req, res) => {
    const user = me(req);
    const personalId = await ensurePersonalId(user);
    const invite = await Invite.findOne({ ownerId: user._id, expiresAt: { $gt: new Date() } }).lean();
    res.json({ personalId, invite: invite ? { code: invite.code, expiresAt: invite.expiresAt } : null, searchesLeft: await searchesLeft(user._id) });
  });

  // The old ID stops working at once; contacts stay. Pending requests sent to the old ID stay too.
  router.post("/me/new-id", async (req, res) => {
    const user = me(req);
    for (let i = 0; i < 5; i++) {
      const id = newPersonalId();
      if (await User.exists({ personalId: id })) continue;
      user.personalId = id;
      await user.save();
      return res.json({ personalId: id });
    }
    throw new HttpError(503, "try_again", "Try again.");
  });

  // One active invite per user: a new one replaces the old.
  router.post("/invite", async (req, res) => {
    const user = me(req);
    const expiresAt = new Date(Date.now() + INVITE_HOURS * 3600_000);
    for (let i = 0; i < 5; i++) {
      const code = newInviteCode();
      if (await Invite.exists({ code })) continue;
      await Invite.findOneAndUpdate({ ownerId: user._id }, { code, expiresAt }, { upsert: true });
      return res.json({ code, expiresAt });
    }
    throw new HttpError(503, "try_again", "Try again.");
  });

  router.delete("/invite", async (req, res) => {
    await Invite.deleteOne({ ownerId: me(req)._id });
    res.json({ ok: true });
  });

  // ---------- List ----------
  router.get("/", async (req, res) => {
    res.json(await contactsView(me(req)));
  });

  // ---------- Add: personal ID (a request) or invite code (contacts at once) ----------
  // Every failure gets the same answer, so nobody can probe who exists, who blocked them or who is in which category.
  router.post("/add", async (req, res) => {
    const body = parse(
      z.union([z.object({ personalId: z.string().max(40) }).strict(), z.object({ inviteCode: z.string().max(40) }).strict()]),
      req.body,
    );
    const user = me(req);
    const left = await searchesLeft(user._id);
    if (left <= 0) throw new HttpError(429, "too_many_searches", "You've used your 10 searches for this hour. Try again later.", { searchesLeft: 0 });
    await Lookup.create({ userId: user._id });
    const details = { searchesLeft: left - 1 };
    const notFoundError = (what: string) => new HttpError(404, "not_found", `No one found with this ${what}. Check it with the person.`, details);

    if ("personalId" in body) {
      const personalId = normalizePersonalId(body.personalId);
      const target = personalId ? await User.findOne({ personalId, role: "user" }) : null;
      if (!target || !(await canConnect(user, target))) throw notFoundError("ID");

      const existing = await Friendship.findOne({ pairKey: pair(user._id, target._id).pairKey });
      if (existing?.status === "accepted") return res.json({ status: "contact", contact: contactJson(target, existing), ...details });
      if (existing && String(existing.requestedBy) === String(user._id)) return res.json({ status: "requested", username: target.username, ...details });
      if (existing) {
        // They had already asked me: asking back is accepting
        existing.status = "accepted";
        existing.acceptedAt = new Date();
        await existing.save();
        bus.contactsChanged([user._id, target._id]);
        return res.json({ status: "contact", contact: contactJson(target, existing), ...details });
      }
      await Friendship.create({ ...pair(user._id, target._id), status: "pending", requestedBy: user._id, via: "id" });
      bus.contactsChanged([user._id, target._id]);
      return res.json({ status: "requested", username: target.username, ...details });
    }

    const code = normalizeInviteCode(body.inviteCode);
    const invite = code ? await Invite.findOne({ code, expiresAt: { $gt: new Date() } }) : null;
    const owner = invite ? await User.findOne({ _id: invite.ownerId, role: "user" }) : null;
    // A code that can't be used stays valid for the person it was meant for
    if (!invite || !owner || !(await canConnect(user, owner))) throw notFoundError("code");

    const now = new Date();
    const friendship = await Friendship.findOneAndUpdate(
      { pairKey: pair(user._id, owner._id).pairKey },
      { $set: { status: "accepted", acceptedAt: now }, $setOnInsert: { ...pair(user._id, owner._id), requestedBy: user._id, via: "invite" } },
      { upsert: true, returnDocument: "after" },
    );
    await invite.deleteOne();
    bus.contactsChanged([user._id, owner._id]);
    res.json({ status: "contact", contact: contactJson(owner, friendship), ...details });
  });

  // ---------- Requests ----------
  async function request(req: Request) {
    const f = await Friendship.findOne({ _id: parse(objectIdSchema, req.params.id), status: "pending", $or: [{ userA: me(req)._id }, { userB: me(req)._id }] });
    if (!f) throw notFound("This request is no longer open.");
    return f;
  }

  router.post("/requests/:id/accept", async (req, res) => {
    const f = await request(req);
    if (String(f.requestedBy) === String(me(req)._id)) throw conflict("You can't accept your own request.");
    const other = await User.findById(f.requestedBy);
    if (!other || !(await canConnect(me(req), other))) throw notFound("This request is no longer open.");
    f.status = "accepted";
    f.acceptedAt = new Date();
    await f.save();
    bus.contactsChanged([f.userA, f.userB]);
    res.json({ ok: true });
  });

  // Declining (recipient) and cancelling (sender) both just delete the request. The other side isn't told why.
  router.post("/requests/:id/decline", async (req, res) => {
    const f = await request(req);
    await f.deleteOne();
    bus.contactsChanged([f.userA, f.userB]);
    res.json({ ok: true });
  });

  // ---------- One contact ----------
  async function contact(req: Request) {
    const otherId = parse(objectIdSchema, req.params.userId);
    const [f, other] = await Promise.all([
      Friendship.findOne({ pairKey: pair(me(req)._id, otherId).pairKey, status: "accepted" }),
      User.findById(otherId),
    ]);
    if (!f || !other || !(await canConnect(me(req), other))) throw notFound("Contact not found");
    return { f, other };
  }

  router.get("/:userId", async (req, res) => {
    const { f, other } = await contact(req);
    res.json({ contact: contactJson(other, f) });
  });

  router.delete("/:userId", async (req, res) => {
    const { f } = await contact(req);
    await f.deleteOne();
    await reconcileChats([f.userA, f.userB]);
    bus.contactsChanged([f.userA, f.userB]);
    res.json({ ok: true });
  });

  // Works on any friendship state (contact or request), and on someone you have no link with.
  router.post("/:userId/block", async (req, res) => {
    const otherId = parse(objectIdSchema, req.params.userId);
    if (String(otherId) === String(me(req)._id)) throw conflict("You can't block yourself.");
    await Block.updateOne({ blockerId: me(req)._id, blockedId: otherId }, { $setOnInsert: { blockerId: me(req)._id, blockedId: otherId } }, { upsert: true });
    await Friendship.deleteOne({ pairKey: pair(me(req)._id, otherId).pairKey });
    await reconcileChats([me(req)._id, otherId]);
    bus.contactsChanged([me(req)._id, otherId]);
    res.json({ ok: true });
  });

  return router;
}
