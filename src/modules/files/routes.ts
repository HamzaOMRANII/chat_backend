import express, { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { Chat } from "../../models/chat.js";
import { FILE_KINDS, StoredFile } from "../../models/file.js";
import { pairOptions } from "../chats/service.js";
import {
  CHUNK_OVERHEAD,
  CHUNK_PLAIN,
  deleteFiles,
  disk,
  DISK_LIMIT,
  MAX_CHUNKS,
  MAX_FILE_BYTES,
  QUOTA_BYTES,
  readChunk,
  saveChunk,
  uploadDeadline,
  usedBy,
} from "./service.js";

/** Encrypted size of piece n of a file of `size` plain bytes. */
const pieceSize = (size: number, chunks: number, n: number) => (n < chunks - 1 ? CHUNK_PLAIN : size - (chunks - 1) * CHUNK_PLAIN) + CHUNK_OVERHEAD;

/** Mounted on /api: /api/chats/:id/files, /api/files/…, /api/media. */
export function createFilesRouter(config: Config) {
  const router = Router();
  router.use(["/files", "/media"], requireUser(config));
  // /chats/… is already guarded by the chats router, but this router can be reached first
  router.use("/chats/:id/files", requireUser(config));
  const me = (req: Request) => auth(req).user;

  async function activeChat(req: Request) {
    const chat = await Chat.findOne({ _id: new Types.ObjectId(parse(objectIdSchema, req.params.id)), participants: me(req)._id, status: "active" });
    if (!chat) throw notFound("This chat has ended.");
    return chat;
  }

  /** A file of a chat this user is in (still open). */
  async function myFile(req: Request) {
    const file = await StoredFile.findById(parse(objectIdSchema, req.params.id));
    const userId = me(req).id;
    if (!file || (String(file.senderId) !== userId && String(file.recipientId) !== userId)) throw notFound("File not found");
    return file;
  }

  // Start an upload: checks the rules, the size, the user's space and the server disk.
  router.post("/chats/:id/files", async (req, res) => {
    const body = parse(z.object({ kind: z.enum(FILE_KINDS), size: z.number().int().min(1).max(MAX_FILE_BYTES, "Files can be up to 100 MB.") }), req.body);
    const user = me(req);
    const chat = await activeChat(req);
    const recipientId = chat.participants.find((p) => String(p) !== user.id)!;
    const options = await pairOptions(user._id, recipientId);
    if (options?.files !== "all") throw forbidden("Files aren't allowed with this contact.", "files_not_allowed");
    const chunks = Math.ceil(body.size / CHUNK_PLAIN);
    const stored = body.size + chunks * CHUNK_OVERHEAD;
    if ((await usedBy(user._id)).bytes + stored > QUOTA_BYTES) throw conflict("Your 2 GB of files is full. Delete some media or wait until it expires.", "quota_full");
    if ((await disk()).ratio >= DISK_LIMIT) throw conflict("The server is full right now. Try again later.", "disk_full");
    const file = await StoredFile.create({ chatId: chat._id, senderId: user._id, recipientId, kind: body.kind, size: stored, chunks, status: "uploading", expiresAt: uploadDeadline() });
    res.status(201).json({ file: { id: file.id, chunks, chunkSize: CHUNK_PLAIN } });
  });

  // One encrypted piece (nonce + ciphertext), raw bytes.
  router.put("/files/:id/chunks/:n", express.raw({ type: "application/octet-stream", limit: CHUNK_PLAIN + CHUNK_OVERHEAD + 1024 }), async (req, res) => {
    const file = await myFile(req);
    if (String(file.senderId) !== me(req).id || file.status !== "uploading") throw conflict("This upload is closed.");
    const n = parse(z.coerce.number().int().min(0).max(MAX_CHUNKS - 1), req.params.n);
    if (n >= file.chunks) throw badRequest("No such piece");
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length !== pieceSize(file.size - file.chunks * CHUNK_OVERHEAD, file.chunks, n)) throw badRequest("Wrong piece size", "bad_piece");
    await saveChunk(file.id, n, data);
    const updated = await StoredFile.findByIdAndUpdate(file._id, { $addToSet: { got: n } }, { new: true });
    res.json({ received: updated!.got.length, chunks: file.chunks });
  });

  router.get("/files/:id/chunks/:n", async (req, res) => {
    const file = await myFile(req);
    if (file.status !== "ready") throw notFound(file.status === "deleted" ? "This file was deleted." : "File not found");
    if (!(await Chat.exists({ _id: file.chatId, status: "active" }))) throw notFound("This chat has ended.");
    const n = parse(z.coerce.number().int().min(0), req.params.n);
    if (n >= file.chunks) throw notFound("No such piece");
    res.set({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store" }).send(await readChunk(file.id, n));
  });

  // The files of a chat (deleted ones too, a day long: the chat shows "removed")
  router.get("/chats/:id/files", async (req, res) => {
    const chat = await activeChat(req);
    const files = await StoredFile.find({ chatId: chat._id, status: { $ne: "uploading" } }).sort({ createdAt: -1 }).lean();
    res.json({
      files: files.map((f) => ({
        id: String(f._id),
        senderId: String(f.senderId),
        kind: f.kind,
        size: f.size,
        status: f.status,
        deletedReason: f.deletedReason ?? null,
        messageId: f.messageId ? String(f.messageId) : null,
        expiresAt: f.expiresAt,
      })),
    });
  });

  // Either participant can delete a file: it's gone for both
  router.post("/files/delete", async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(objectIdSchema).min(1).max(500) }), req.body);
    const userId = me(req)._id;
    const files = await StoredFile.find({ _id: { $in: ids }, $or: [{ senderId: userId }, { recipientId: userId }], status: { $ne: "deleted" } });
    await deleteFiles(files, "deleted_by_user", me(req).id);
    res.json({ deleted: files.length });
  });

  // My space and any download request from the administrator
  router.get("/media", async (req, res) => {
    const user = me(req);
    const used = await usedBy(user._id);
    const perChat = await StoredFile.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { $or: [{ senderId: user._id }, { recipientId: user._id }], status: "ready" } },
      { $group: { _id: "$chatId", n: { $sum: 1 } } },
    ]);
    res.json({
      used: used.bytes,
      files: used.files,
      limit: QUOTA_BYTES,
      maxFile: MAX_FILE_BYTES,
      request: user.mediaRequest?.deadline ? { deadline: user.mediaRequest.deadline } : null,
      chats: perChat.map((c) => ({ chatId: String(c._id), files: c.n })),
    });
  });

  return router;
}
