import { Types } from "mongoose";
import { bus } from "../../lib/events.js";
import { logger } from "../../lib/logger.js";
import { Category } from "../../models/category.js";
import { AUTO_MINUTES, Chat, RETENTION_MINUTES, type ChatDoc, type StoredMode } from "../../models/chat.js";
import { LiveSession } from "../../models/liveSession.js";
import { Friendship, pair } from "../../models/friendship.js";
import { Message } from "../../models/message.js";
import { User } from "../../models/user.js";
import { blockedEitherWay, effectiveCategoryId, sharedCategoryIds } from "../contacts/service.js";
import { reconcileLive } from "../live/service.js";
import { notify } from "../notify/service.js";

export const INVITE_HOURS = 24;
export const ENDED_KEEP_DAYS = 30;
const AUTO_DAYS = AUTO_MINUTES / 1440;

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

/** Keep-alive: any offered duration up to the category's maximum days. Automatic: always 7 days. */
export function allows(options: ChatOptions | null, mode: StoredMode, minutes: number) {
  if (!options) return false;
  if (mode === "auto") return options.auto && minutes === AUTO_MINUTES;
  return (RETENTION_MINUTES as readonly number[]).includes(minutes) && minutes <= options.keepMaxDays * 1440;
}

/** What the other person is told when a chat ends ("who" = the one who did it, or the other participant). */
const ENDED_TEXT: Record<string, (who: string) => { title: string; body: string }> = {
  declined: (who) => ({ title: who, body: "declined your chat invitation" }),
  cancelled: (who) => ({ title: who, body: "cancelled the chat invitation" }),
  ended_by_user: (who) => ({ title: who, body: "ended the chat. All messages were deleted." }),
  invite_expired: (who) => ({ title: who, body: "The chat invitation expired without an answer." }),
  expired: (who) => ({ title: who, body: "The chat ended: all its messages had expired." }),
};

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

  const people = await User.find({ _id: { $in: chat.participants } }).select("username").lean();
  const name = (id: Types.ObjectId) => people.find((p) => String(p._id) === String(id))?.username ?? "Your contact";
  for (const userId of chat.participants) {
    if (by && String(userId) === String(by)) continue;
    const other = chat.participants.find((p) => String(p) !== String(userId))!;
    const text = (ENDED_TEXT[reason] ?? ((who: string) => ({ title: who, body: "Your chat was closed. All messages were deleted." })))(name(other));
    void notify(userId, { kind: reason === "declined" ? "chat_declined" : "chat_ended", ...text, tag: `chat:${chat.id}`, open: {} });
  }
}

/**
 * Re-checks the open chats of these users after anything that can change what they're allowed:
 * contact removed or paused, block, category or rules changed, suspension. Chats that no longer fit end.
 */
export async function reconcileChats(userIds: (Types.ObjectId | string)[]) {
  const ids = [...new Set(userIds.map(String))].map((id) => new Types.ObjectId(id));
  if (!ids.length) return 0;
  await reconcileLive(ids);
  const open = await Chat.find({ participants: { $in: ids }, status: { $in: ["invited", "active"] } });
  let ended = 0;
  for (const chat of open) {
    const [a, b] = chat.participants;
    const options = await pairOptions(a!, b!);
    if (!allows(options, chat.mode as StoredMode, chat.retentionMinutes)) {
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
  const live = await LiveSession.find({ status: { $in: ["invited", "active"] } }).select("participants").lean();
  return reconcileChats([...open, ...live].flatMap((c) => c.participants));
}

/** Every minute: unanswered invitations expire; chats whose last message is gone (no activity for the retention) end. */
export async function expireChats() {
  const now = Date.now();
  for (const chat of await Chat.find({ status: "invited", inviteExpiresAt: { $lt: new Date(now) } })) await endChat(chat, "invite_expired");
  const active = await Chat.find({ status: "active" });
  for (const chat of active) {
    const last = (chat.lastMessageAt ?? chat.acceptedAt ?? chat.invitedAt)!.getTime();
    if (last + chat.retentionMinutes * 60_000 < now && !(await Message.exists({ chatId: chat._id }))) await endChat(chat, "expired");
  }
}
