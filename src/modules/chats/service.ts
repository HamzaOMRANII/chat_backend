import { Types } from "mongoose";
import { bus } from "../../lib/events.js";
import { logger } from "../../lib/logger.js";
import { Category } from "../../models/category.js";
import { Chat, type ChatDoc, type StoredMode } from "../../models/chat.js";
import { Friendship, pair } from "../../models/friendship.js";
import { Message } from "../../models/message.js";
import { User } from "../../models/user.js";
import { blockedEitherWay, effectiveCategoryId, sharedCategoryIds } from "../contacts/service.js";

export const INVITE_HOURS = 24;
export const ENDED_KEEP_DAYS = 30;
const AUTO_DAYS = 7;

export type ChatOptions = { keepMaxDays: number; auto: boolean; live: boolean };

/**
 * What two users may open together, from the rules of the category their contact uses. null = they aren't
 * (or are no longer) contacts in good standing: removed, paused, blocked, or one of them not approved.
 */
export async function pairOptions(aId: Types.ObjectId | string, bId: Types.ObjectId | string): Promise<(ChatOptions & { categoryId: string }) | null> {
  const [a, b, friendship] = await Promise.all([
    User.findById(aId).select("status role categoryIds").lean(),
    User.findById(bId).select("status role categoryIds").lean(),
    Friendship.findOne({ pairKey: pair(aId, bId).pairKey, status: "accepted" }).lean(),
  ]);
  if (!a || !b || !friendship || a.status !== "approved" || b.status !== "approved" || a.role !== "user" || b.role !== "user") return null;
  if (await blockedEitherWay(aId, bId)) return null;
  const categoryId = await effectiveCategoryId(sharedCategoryIds(a, b), friendship.categoryId);
  if (!categoryId) return null;
  const category = await Category.findById(categoryId).lean();
  if (!category) return null;
  const modes = category.rules?.modes ?? [];
  const max = category.rules?.maxRetentionDays ?? 0;
  return {
    categoryId,
    keepMaxDays: modes.includes("keep") ? max : 0,
    auto: modes.includes("auto") && max >= AUTO_DAYS,
    live: modes.includes("live"),
  };
}

export function allows(options: ChatOptions | null, mode: StoredMode, days: number) {
  if (!options) return false;
  return mode === "auto" ? options.auto && days === AUTO_DAYS : options.keepMaxDays >= days && days >= 1;
}

/** Ends a chat: every message and both public chat keys are deleted at once; metadata stays 30 days. */
export async function endChat(chat: ChatDoc, reason: string, by?: Types.ObjectId | null) {
  if (chat.status === "ended") return;
  chat.status = "ended";
  chat.endedAt = new Date();
  chat.endedBy = by ?? undefined;
  chat.endReason = reason;
  chat.purgeAt = new Date(Date.now() + ENDED_KEEP_DAYS * 24 * 3600_000);
  chat.set("keys", []);
  await chat.save();
  await Message.deleteMany({ chatId: chat._id });
  bus.toUsers(chat.participants, "chat:ended", { chatId: chat.id, reason, by: by ? String(by) : null });
}

/**
 * Re-checks the open chats of these users after anything that can change what they're allowed:
 * contact removed or paused, block, category or rules changed, suspension. Chats that no longer fit end.
 */
export async function reconcileChats(userIds: (Types.ObjectId | string)[]) {
  const ids = [...new Set(userIds.map(String))].map((id) => new Types.ObjectId(id));
  if (!ids.length) return 0;
  const open = await Chat.find({ participants: { $in: ids }, status: { $in: ["invited", "active"] } });
  let ended = 0;
  for (const chat of open) {
    const [a, b] = chat.participants;
    const options = await pairOptions(a!, b!);
    if (!allows(options, chat.mode as StoredMode, chat.retentionDays)) {
      await endChat(chat, options ? "rules_changed" : "contact_unavailable");
      ended++;
    }
  }
  if (ended) logger.info({ ended }, "ended chats that no longer fit the rules");
  return ended;
}

/** All open chats, for a rules change on a whole category. */
export async function reconcileAllChats() {
  const open = await Chat.find({ status: { $in: ["invited", "active"] } }).select("participants").lean();
  return reconcileChats(open.flatMap((c) => c.participants));
}

/** Hourly: unanswered invitations expire; chats whose last message is gone (no activity for the retention) end. */
export async function expireChats() {
  const now = Date.now();
  for (const chat of await Chat.find({ status: "invited", inviteExpiresAt: { $lt: new Date(now) } })) await endChat(chat, "invite_expired");
  const active = await Chat.find({ status: "active" });
  for (const chat of active) {
    const last = (chat.lastMessageAt ?? chat.acceptedAt ?? chat.invitedAt)!.getTime();
    if (last + chat.retentionDays * 24 * 3600_000 < now && !(await Message.exists({ chatId: chat._id }))) await endChat(chat, "expired");
  }
}
