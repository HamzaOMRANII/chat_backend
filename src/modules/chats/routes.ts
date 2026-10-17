import { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { bus } from "../../lib/events.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { AUTO_MINUTES, Chat, STORED_MODES, type ChatDoc } from "../../models/chat.js";
import { pair } from "../../models/friendship.js";
import { Message } from "../../models/message.js";
import { User, type UserDoc } from "../../models/user.js";
import { presence } from "../../realtime/presence.js";
import { notify, retentionText } from "../notify/service.js";
import { allows, endChat, INVITE_HOURS, pairOptions } from "./service.js";

// libsodium base64 (original variant): 32-byte keys, 64-byte signatures, 24-byte nonces
const key32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "invalid key");
const sig64 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "invalid signature");
const nonce24 = z.string().regex(/^[A-Za-z0-9+/]{32}$/, "invalid nonce");
// Up to 4,000 characters of text once encrypted
const ciphertext = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "invalid ciphertext").max(24_000, "message too long");
const chatKey = z.object({ pub: key32, sig: sig64 });

/** Mounted on /api: only /api/chats/… and /api/keys/… need the user session (the rest of /api passes through). */
export function createChatsRouter(config: Config) {
  const router = Router();
  router.use(["/chats", "/keys"], requireUser(config));
  const me = (req: Request) => auth(req).user;

  /** The other participant of a chat, seen from `userId`. */
  const otherId = (chat: { participants: Types.ObjectId[] }, userId: Types.ObjectId | string) => chat.participants.find((p) => String(p) !== String(userId))!;

  type ChatStatus = "invited" | "active" | "ended";
  async function openChat(req: Request, statuses: ChatStatus[] = ["invited", "active"]): Promise<ChatDoc> {
    const chat = await Chat.findOne({ _id: new Types.ObjectId(parse(objectIdSchema, req.params.id)), participants: me(req)._id, status: { $in: statuses } });
    if (!chat) throw notFound("This chat has ended.");
    return chat;
  }

  async function chatsJson(user: UserDoc, chats: ChatDoc[]) {
    const others = await User.find({ _id: { $in: chats.map((c) => otherId(c, user._id)) } }).select("username lastSeenAt identity").lean();
    const byId = new Map(others.map((u) => [String(u._id), u]));
    const unread = await Message.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { recipientId: user._id, readAt: null, chatId: { $in: chats.map((c) => c._id) } } },
      { $group: { _id: "$chatId", n: { $sum: 1 } } },
    ]);
    const unreadBy = new Map(unread.map((u) => [String(u._id), u.n]));
    return chats.map((chat) => {
      const other = byId.get(String(otherId(chat, user._id)));
      return {
        id: chat.id,
        with: other
          ? { id: String(other._id), username: other.username, online: presence.isOnline(other._id), lastSeenAt: other.lastSeenAt ?? null, identityPub: other.identity?.signPub ?? null }
          : null,
        mode: chat.mode,
        retentionMinutes: chat.retentionMinutes,
        status: chat.status,
        createdByMe: String(chat.createdBy) === user.id,
        invitedAt: chat.invitedAt,
        inviteExpiresAt: chat.inviteExpiresAt ?? null,
        acceptedAt: chat.acceptedAt ?? null,
        lastMessageAt: chat.lastMessageAt ?? null,
        unread: unreadBy.get(chat.id) ?? 0,
        keys: chat.keys.map((k) => ({ userId: String(k.userId), version: k.version, pub: k.pub, sig: k.sig, identityPub: k.identityPub })),
      };
    });
  }

  /** The key a participant adds must be signed by the identity key of their current device. */
  function signedKey(user: UserDoc, key: { pub: string; sig: string }, version: number) {
    if (!user.identity?.signPub) throw conflict("Set up this device's keys first.", "no_identity");
    return { userId: user._id, version, pub: key.pub, sig: key.sig, identityPub: user.identity.signPub };
  }

  // ---------- This device's identity key ----------
  router.put("/keys/identity", async (req, res) => {
    const body = parse(z.object({ deviceId: z.string().min(8).max(100), signPub: key32 }), req.body);
    const user = me(req);
    if (auth(req).session.device?.deviceId && body.deviceId !== auth(req).session.device?.deviceId) throw forbidden("This key belongs to another device.");
    const changed = user.identity?.signPub !== body.signPub;
    if (changed) {
      user.identity = { deviceId: body.deviceId, signPub: body.signPub, at: new Date() };
      await user.save();
      // Contacts in open chats see "new device" and a new safety code
      const open = await Chat.find({ participants: user._id, status: { $in: ["invited", "active"] } }).select("participants").lean();
      bus.toUsers(open.map((c) => otherId(c, user._id)), "chats:changed");
    }
    res.json({ changed });
  });

  // ---------- Chats ----------
  router.get("/chats", async (req, res) => {
    const chats = await Chat.find({ participants: me(req)._id, status: { $in: ["invited", "active"] } }).sort({ lastMessageAt: -1, invitedAt: -1 });
    res.json({ chats: await chatsJson(me(req), chats) });
  });

  router.get("/chats/:id", async (req, res) => {
    const [chat] = await chatsJson(me(req), [await openChat(req)]);
    res.json({ chat });
  });

  // What this user may open with a contact (modes and days), for the Start chat dialog.
  router.get("/chats/options/:userId", async (req, res) => {
    const options = await pairOptions(me(req)._id, parse(objectIdSchema, req.params.userId));
    if (!options) throw notFound("Contact not found");
    const { categoryId: _hidden, ...visible } = options;
    res.json({ options: visible });
  });

  router.post("/chats", async (req, res) => {
    const body = parse(
      z.object({ userId: objectIdSchema, mode: z.enum(STORED_MODES), retentionMinutes: z.number().int().min(1).max(AUTO_MINUTES), key: chatKey }),
      req.body,
    );
    const user = me(req);
    const options = await pairOptions(user._id, body.userId);
    if (!options) throw notFound("Contact not found");
    if (!allows(options, body.mode, body.retentionMinutes)) throw badRequest("This chat mode isn't available with this contact.", "mode_not_allowed");
    if (await Chat.exists({ pairKey: pair(user._id, body.userId).pairKey, status: { $in: ["invited", "active"] } })) {
      throw conflict("You already have a chat with this contact.", "chat_exists");
    }
    const chat = await Chat.create({
      participants: [user._id, new Types.ObjectId(body.userId)],
      pairKey: pair(user._id, body.userId).pairKey,
      mode: body.mode,
      retentionMinutes: body.retentionMinutes,
      status: "invited",
      createdBy: user._id,
      categoryId: options.categoryId,
      keys: [signedKey(user, body.key, 1)],
      inviteExpiresAt: new Date(Date.now() + INVITE_HOURS * 3600_000),
    });
    bus.toUsers([body.userId], "chats:changed");
    void notify(body.userId, {
      kind: "chat_invite",
      title: user.username,
      body: `invites you to ${body.mode === "auto" ? "an Automatic" : "a Keep-alive"} chat · messages stay ${retentionText(body.retentionMinutes)}`,
      tag: `chat:${chat.id}`,
      open: { chatId: chat.id },
    });
    const [json] = await chatsJson(user, [chat]);
    res.status(201).json({ chat: json });
  });

  router.post("/chats/:id/accept", async (req, res) => {
    const { key } = parse(z.object({ key: chatKey }), req.body);
    const user = me(req);
    const chat = await openChat(req, ["invited"]);
    if (String(chat.createdBy) === user.id) throw conflict("Wait for the other person to accept.");
    const options = await pairOptions(chat.participants[0]!, chat.participants[1]!);
    if (!allows(options, chat.mode as "keep" | "auto", chat.retentionMinutes)) {
      await endChat(chat, "rules_changed");
      throw notFound("This chat has ended.");
    }
    chat.keys.push(signedKey(user, key, 1));
    chat.status = "active";
    chat.acceptedAt = new Date();
    chat.inviteExpiresAt = undefined;
    await chat.save();
    bus.toUsers(chat.participants, "chats:changed");
    // The one who invited: their app opens the chat
    bus.toUsers([chat.createdBy], "chat:accepted", { chatId: chat.id, by: user.id });
    void notify(chat.createdBy, { kind: "chat_accepted", title: user.username, body: "accepted your chat. You can write now.", tag: `chat:${chat.id}`, open: { chatId: chat.id } });
    const [json] = await chatsJson(user, [chat]);
    res.json({ chat: json });
  });

  // Declining an invitation, cancelling one, or ending a chat: all delete everything for both.
  router.post("/chats/:id/decline", async (req, res) => {
    const chat = await openChat(req, ["invited"]);
    await endChat(chat, String(chat.createdBy) === me(req).id ? "cancelled" : "declined", me(req)._id);
    res.json({ ok: true });
  });

  router.delete("/chats/:id", async (req, res) => {
    const chat = await openChat(req);
    await endChat(chat, chat.status === "invited" ? "cancelled" : "ended_by_user", me(req)._id);
    res.json({ ok: true });
  });

  // New device: a new chat key, signed by the new identity. Messages sent before stay readable by the other side only.
  router.post("/chats/:id/keys", async (req, res) => {
    const { key } = parse(z.object({ key: chatKey }), req.body);
    const user = me(req);
    const chat = await openChat(req);
    const mine = chat.keys.filter((k) => String(k.userId) === user.id);
    if (!mine.length && chat.status === "invited") throw conflict("Accept the invitation first.");
    const version = Math.max(0, ...mine.map((k) => k.version)) + 1;
    chat.keys.push(signedKey(user, key, version));
    await chat.save();
    bus.toUsers([otherId(chat, user._id)], "chat:keys", { chatId: chat.id });
    res.json({ version });
  });

  // ---------- Messages ----------
  router.get("/chats/:id/messages", async (req, res) => {
    const q = parse(z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
    const user = me(req);
    const chat = await openChat(req, ["active"]);
    const messages = await Message.find({ chatId: chat._id, ...(q.before ? { sentAt: { $lt: new Date(q.before) } } : {}) })
      .sort({ sentAt: -1 })
      .limit(q.limit)
      .lean();
    res.json({
      messages: messages.reverse().map((m) => ({
        id: String(m._id),
        senderId: String(m.senderId),
        ciphertext: m.ciphertext,
        nonce: m.nonce,
        senderKeyVersion: m.senderKeyVersion,
        recipientKeyVersion: m.recipientKeyVersion,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt ?? null,
        readAt: m.readAt ?? null,
        expiresAt: m.expiresAt,
      })),
      me: user.id,
    });
  });

  router.post("/chats/:id/messages", async (req, res) => {
    const body = parse(
      z.object({ ciphertext, nonce: nonce24, senderKeyVersion: z.number().int().min(1), recipientKeyVersion: z.number().int().min(1) }),
      req.body,
    );
    const user = me(req);
    const chat = await openChat(req, ["active"]);
    const recipientId = otherId(chat, user._id);
    const has = (userId: Types.ObjectId, version: number) => chat.keys.some((k) => String(k.userId) === String(userId) && k.version === version);
    if (!has(user._id, body.senderKeyVersion) || !has(recipientId, body.recipientKeyVersion)) throw conflict("The chat keys changed. Reload the chat.", "stale_keys");
    const sentAt = new Date();
    const size = Math.floor((body.ciphertext.length * 3) / 4);
    const message = await Message.create({
      chatId: chat._id,
      senderId: user._id,
      recipientId,
      ...body,
      size,
      sentAt,
      expiresAt: new Date(sentAt.getTime() + chat.retentionMinutes * 60_000),
    });
    await Chat.updateOne({ _id: chat._id }, { $set: { lastMessageAt: sentAt }, $inc: { messageCount: 1, storedBytes: size } });
    const json = {
      id: message.id,
      senderId: user.id,
      ciphertext: message.ciphertext,
      nonce: message.nonce,
      senderKeyVersion: message.senderKeyVersion,
      recipientKeyVersion: message.recipientKeyVersion,
      sentAt,
      deliveredAt: null,
      readAt: null,
      expiresAt: message.expiresAt,
    };
    bus.toUsers([recipientId], "msg:new", { chatId: chat.id, message: json });
    // Content is encrypted: the notification only says who wrote
    void notify(recipientId, { kind: "message", title: user.username, body: "New message", tag: `chat:${chat.id}`, open: { chatId: chat.id } });
    res.status(201).json({ message: json });
  });

  // The recipient's app confirms delivery (it received them) and reading (the chat is open on screen).
  router.post("/chats/:id/receipts", async (req, res) => {
    const { read } = parse(z.object({ read: z.boolean() }), req.body);
    const user = me(req);
    const chat = await openChat(req, ["active"]);
    const now = new Date();
    const base = { chatId: chat._id, recipientId: user._id };
    const delivered = await Message.find({ ...base, deliveredAt: null }).select("_id").lean();
    if (delivered.length) await Message.updateMany({ ...base, deliveredAt: null }, { deliveredAt: now });
    let readIds: string[] = [];
    if (read) {
      const unread = await Message.find({ ...base, readAt: null }).select("_id").lean();
      readIds = unread.map((m) => String(m._id));
      if (readIds.length) await Message.updateMany({ ...base, readAt: null }, { readAt: now, deliveredAt: now });
    }
    const deliveredIds = delivered.map((m) => String(m._id));
    if (deliveredIds.length || readIds.length) {
      bus.toUsers([otherId(chat, user._id)], "msg:status", { chatId: chat.id, delivered: deliveredIds, read: readIds, at: now });
    }
    res.json({ delivered: deliveredIds.length, read: readIds.length });
  });

  return router;
}
