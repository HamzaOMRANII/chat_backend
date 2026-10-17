import { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { conflict, forbidden, notFound } from "../../lib/errors.js";
import { bus } from "../../lib/events.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { Chat } from "../../models/chat.js";
import { ExportRequest, type ExportDoc } from "../../models/exportRequest.js";
import { StoredFile } from "../../models/file.js";
import { Message } from "../../models/message.js";
import { pairOptions } from "../chats/service.js";
import { notify } from "../notify/service.js";

export const EXPORT_HOURS = 24;
const KEEP_DAYS = 30;
const PERIOD_MS = { all: null, "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000 } as const;

export function exportJson(e: ExportDoc) {
  return {
    id: e.id as string,
    chatId: String(e.chatId),
    requestedBy: String(e.requestedBy),
    approverId: String(e.approverId),
    messages: e.messages,
    media: e.media,
    period: e.period,
    counts: e.counts ?? { messages: 0, files: 0, bytes: 0 },
    status: e.status,
    requestedAt: e.requestedAt,
    answeredAt: e.answeredAt ?? null,
    until: e.until,
    downloadedAt: e.downloadedAt ?? null,
  };
}

/** Pending requests nobody answered, and approved windows that ran out (every minute). */
export async function expireExports() {
  const now = new Date();
  const stale = await ExportRequest.find({ status: { $in: ["pending", "approved"] }, until: { $lt: now }, purgeAt: null });
  for (const e of stale) {
    // Pending: nobody answered. Approved: the 24 hours to save it are over (it stays "approved" in the history).
    if (e.status === "pending") e.status = "expired";
    e.purgeAt = new Date(now.getTime() + KEEP_DAYS * 864e5);
    await e.save();
  }
  return stale.length;
}

/** Mounted on /api: /api/chats/:id/exports and /api/exports/… */
export function createExportsRouter(config: Config) {
  const router = Router();
  router.use(["/exports", "/chats/:id/exports"], requireUser(config));
  const me = (req: Request) => auth(req).user;

  async function activeChat(req: Request) {
    const chat = await Chat.findOne({ _id: new Types.ObjectId(parse(objectIdSchema, req.params.id)), participants: me(req)._id, status: "active" });
    if (!chat) throw notFound("This chat has ended.");
    return chat;
  }
  async function myExport(req: Request) {
    const e = await ExportRequest.findById(parse(objectIdSchema, req.params.id));
    const id = me(req).id;
    if (!e || (String(e.requestedBy) !== id && String(e.approverId) !== id)) throw notFound("Export not found");
    if (!(await Chat.exists({ _id: e.chatId, status: "active" }))) throw notFound("This chat has ended.");
    return e;
  }
  const changed = (e: ExportDoc) => bus.toUsers([e.requestedBy, e.approverId], "exports:changed", { chatId: String(e.chatId) });

  router.get("/chats/:id/exports", async (req, res) => {
    const chat = await activeChat(req);
    const list = await ExportRequest.find({ chatId: chat._id }).sort({ requestedAt: -1 }).limit(10);
    res.json({ exports: list.map(exportJson) });
  });

  router.post("/chats/:id/exports", async (req, res) => {
    const body = parse(z.object({ messages: z.boolean(), media: z.boolean(), period: z.enum(["all", "24h", "7d"]) }), req.body);
    if (!body.messages && !body.media) throw conflict("Choose messages, media or both.", "nothing_chosen");
    const user = me(req);
    const chat = await activeChat(req);
    const approverId = chat.participants.find((p) => String(p) !== user.id)!;
    // Every category can export: the other side's approval is what protects the chat
    if (!(await pairOptions(user._id, approverId))) throw notFound("Contact not found");
    if (await ExportRequest.exists({ chatId: chat._id, requestedBy: user._id, status: "pending", until: { $gt: new Date() } })) {
      throw conflict("You already asked. Wait for the answer.", "export_pending");
    }
    const since = PERIOD_MS[body.period] ? new Date(Date.now() - PERIOD_MS[body.period]!) : null;
    const when = since ? { $gte: since } : undefined;
    const [messages, files] = await Promise.all([
      body.messages ? Message.countDocuments({ chatId: chat._id, ...(when ? { sentAt: when } : {}) }) : 0,
      body.media ? StoredFile.find({ chatId: chat._id, status: "ready", ...(when ? { createdAt: when } : {}) }).select("size").lean() : [],
    ]);
    const e = await ExportRequest.create({
      chatId: chat._id,
      requestedBy: user._id,
      approverId,
      ...body,
      counts: { messages, files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) },
      status: "pending",
      until: new Date(Date.now() + EXPORT_HOURS * 3600_000),
    });
    changed(e);
    void notify(approverId, { kind: "export_request", title: user.username, body: "wants to export your chat. Approve or refuse.", tag: `chat:${chat.id}`, open: { chatId: chat.id } });
    res.status(201).json({ export: exportJson(e) });
  });

  router.post(["/exports/:id/approve", "/exports/:id/refuse"], async (req, res) => {
    const e = await myExport(req);
    if (String(e.approverId) !== me(req).id) throw forbidden("Only the other person can answer.");
    if (e.status !== "pending" || e.until < new Date()) throw conflict("This request isn't waiting for an answer anymore.", "not_pending");
    const ok = req.path.endsWith("/approve");
    e.status = ok ? "approved" : "refused";
    e.answeredAt = new Date();
    e.until = ok ? new Date(Date.now() + EXPORT_HOURS * 3600_000) : e.until;
    if (!ok) e.purgeAt = new Date(Date.now() + KEEP_DAYS * 864e5);
    await e.save();
    changed(e);
    void notify(e.requestedBy, {
      kind: "export_answer",
      title: me(req).username,
      body: ok ? `approved your export. You have ${EXPORT_HOURS} hours to save it.` : "refused your export.",
      tag: `chat:${String(e.chatId)}`,
      open: { chatId: String(e.chatId) },
    });
    res.json({ export: exportJson(e) });
  });

  // The requester saved the zip (recorded for both, and for the backoffice)
  router.post("/exports/:id/downloaded", async (req, res) => {
    const e = await myExport(req);
    if (String(e.requestedBy) !== me(req).id) throw forbidden("Not your export.");
    if (e.status !== "approved" || e.until < new Date()) throw conflict("The 24 hours to save this export are over. Ask again.", "export_closed");
    e.downloadedAt = new Date();
    e.purgeAt = new Date(e.until.getTime() + KEEP_DAYS * 864e5);
    await e.save();
    changed(e);
    res.json({ export: exportJson(e) });
  });

  router.delete("/exports/:id", async (req, res) => {
    const e = await myExport(req);
    if (String(e.requestedBy) !== me(req).id || e.status !== "pending") throw conflict("Only a waiting request can be cancelled.");
    e.status = "cancelled";
    e.purgeAt = new Date(Date.now() + KEEP_DAYS * 864e5);
    await e.save();
    changed(e);
    res.json({ ok: true });
  });

  return router;
}
