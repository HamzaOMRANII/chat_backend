import { mkdir, rm, statfs, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Types } from "mongoose";
import { bus } from "../../lib/events.js";
import { logger } from "../../lib/logger.js";
import { StoredFile, type FileDoc } from "../../models/file.js";
import { User } from "../../models/user.js";
import { Group } from "../../models/group.js";
import { notify } from "../notify/service.js";

/** One file at most 100 MB (plain), each user's files at most 2 GB, uploads stop when the disk is 80 % full. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const DISK_LIMIT = 0.8;
/** Pieces are encrypted separately: 4 MiB of file each, plus a 24-byte nonce and a 16-byte tag. */
export const CHUNK_PLAIN = 4 * 1024 * 1024;
export const CHUNK_OVERHEAD = 40;
export const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / CHUNK_PLAIN);
const UPLOAD_HOURS = 1;
const KEEP_DELETED_HOURS = 24;

let mediaDir = "/var/lib/h-chat/media";
export function configureMedia(dir: string) {
  mediaDir = dir;
}
export const fileDir = (id: string | Types.ObjectId) => path.join(mediaDir, String(id));
export const chunkPath = (id: string | Types.ObjectId, n: number) => path.join(fileDir(id), String(n));

export async function saveChunk(id: string, n: number, data: Buffer) {
  await mkdir(fileDir(id), { recursive: true });
  await writeFile(chunkPath(id, n), data);
}
export const readChunk = (id: string, n: number) => readFile(chunkPath(id, n));

/** How full the disk holding the media is (0..1), and its size. */
export async function disk() {
  await mkdir(mediaDir, { recursive: true });
  const s = await statfs(mediaDir);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  return { total, used: total - free, ratio: total ? (total - free) / total : 0 };
}

/** Space a user's files take (sent by them, still on the server). */
export async function usedBy(userId: Types.ObjectId | string) {
  const [r] = await StoredFile.aggregate<{ bytes: number; n: number }>([
    { $match: { senderId: new Types.ObjectId(String(userId)), status: { $in: ["uploading", "ready"] } } },
    { $group: { _id: null, bytes: { $sum: "$size" }, n: { $sum: 1 } } },
  ]);
  return { bytes: r?.bytes ?? 0, files: r?.n ?? 0 };
}

/** Deletes files from the disk; their records say why (the chats show "removed"). */
export async function deleteFiles(files: FileDoc[], reason: string, by?: string) {
  const byChat = new Map<string, { ids: string[]; people: string[] }>();
  for (const file of files) {
    if (file.status === "deleted") continue;
    await rm(fileDir(file.id), { recursive: true, force: true });
    file.status = "deleted";
    file.deletedAt = new Date();
    file.deletedReason = reason;
    file.purgeAt = new Date(Date.now() + KEEP_DELETED_HOURS * 3600_000);
    await file.save();
    const where = file.groupId ? `group:${String(file.groupId)}` : String(file.chatId);
    const people = file.groupId
      ? ((await Group.findById(file.groupId).select("members").lean())?.members.map(String) ?? [String(file.senderId)])
      : [String(file.senderId), String(file.recipientId)];
    const entry = byChat.get(where) ?? { ids: [], people };
    entry.ids.push(file.id);
    byChat.set(where, entry);
  }
  for (const [where, { ids, people }] of byChat) {
    const place = where.startsWith("group:") ? { groupId: where.slice(6) } : { chatId: where };
    bus.toUsers(people, "files:deleted", { ...place, fileIds: ids, reason, by: by ?? null });
  }
  return files.length;
}

let lastCleanup: { at: Date; files: number; bytes: number } | null = null;
export const lastCleanupResult = () => lastCleanup;

/**
 * Every minute: files whose message expired, abandoned uploads, and media the administrator asked users
 * to download once the deadline passed. Reminds those users 24 h and 1 h before.
 */
export async function cleanupFiles() {
  const now = new Date();
  const expired = await StoredFile.find({ status: { $in: ["uploading", "ready"] }, expiresAt: { $lt: now } });
  const bytes = expired.reduce((a, f) => a + f.size, 0);
  await deleteFiles(expired, "expired");

  for (const user of await User.find({ "mediaRequest.deadline": { $ne: null } })) {
    const deadline = user.mediaRequest!.deadline!;
    if (deadline <= now) {
      const files = await StoredFile.find({ senderId: user._id, status: { $in: ["uploading", "ready"] } });
      await deleteFiles(files, "removed_by_admin");
      user.set("mediaRequest", undefined);
      await user.save();
      continue;
    }
    const left = deadline.getTime() - now.getTime();
    const reminded = user.mediaRequest!.reminded ?? [];
    const due = left <= 3600_000 ? "1h" : left <= 24 * 3600_000 ? "24h" : null;
    if (due && !reminded.includes(due)) {
      user.set("mediaRequest.reminded", [...reminded, due]);
      await user.save();
      void notify(user._id, {
        kind: "media_request",
        title: "Download your media",
        body: `Your files will be deleted in ${due === "1h" ? "1 hour" : "24 hours"}.`,
        tag: "media-request",
        open: { media: true },
      });
    }
  }
  if (expired.length) {
    lastCleanup = { at: now, files: expired.length, bytes };
    logger.info({ files: expired.length, bytes }, "expired files deleted");
  } else if (!lastCleanup || now.getTime() - lastCleanup.at.getTime() > 3600_000) lastCleanup = { at: now, files: 0, bytes: 0 };
  return { files: expired.length, bytes };
}

export const uploadDeadline = () => new Date(Date.now() + UPLOAD_HOURS * 3600_000);
