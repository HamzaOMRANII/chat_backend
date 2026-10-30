import { randomInt } from "node:crypto";
import type { Types } from "mongoose";
import { Block } from "../../models/block.js";
import { Category } from "../../models/category.js";
import { Friendship, otherUserId } from "../../models/friendship.js";
import { User, type UserDoc } from "../../models/user.js";
import { presence } from "../../realtime/presence.js";

// No 0/O, 1/I/L: easy to read out loud and type
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const randomChars = (n: number) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

export const newPersonalId = () => `HC-${randomChars(4)}-${randomChars(4)}`;
export const newInviteCode = () => `${randomChars(4)}-${randomChars(4)}`;

/** Accepts "hc-4kx7 92qm", "4KX792QM", "HC-4KX7-92QM"…; returns the stored form or null. */
export function normalizePersonalId(input: string) {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^HC/, "");
  return raw.length === 8 && [...raw].every((c) => ALPHABET.includes(c)) ? `HC-${raw.slice(0, 4)}-${raw.slice(4)}` : null;
}
export function normalizeInviteCode(input: string) {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 && [...raw].every((c) => ALPHABET.includes(c)) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
}

/** Gives the user a personal ID if they have none yet (retries on the rare collision). */
export async function ensurePersonalId(user: UserDoc) {
  for (let i = 0; !user.personalId && i < 5; i++) {
    const id = newPersonalId();
    if (!(await User.exists({ personalId: id }))) {
      user.personalId = id;
      await user.save();
    }
  }
  return user.personalId!;
}

export const sharedCategoryIds = (a: { categoryIds: Types.ObjectId[] }, b: { categoryIds: Types.ObjectId[] }) => {
  const mine = new Set(a.categoryIds.map(String));
  return b.categoryIds.map(String).filter((id) => mine.has(id));
};

/** The category whose rules apply to a pair: the admin's choice if still shared, else the first shared one by order. */
export async function effectiveCategoryId(shared: string[], override?: Types.ObjectId | null) {
  if (!shared.length) return null;
  if (override && shared.includes(String(override))) return String(override);
  const first = await Category.findOne({ _id: { $in: shared } }).sort({ order: 1 }).select("_id").lean();
  return first ? String(first._id) : null;
}

export async function blockedEitherWay(a: Types.ObjectId | string, b: Types.ObjectId | string) {
  return !!(await Block.exists({ $or: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] }));
}

/** Can these two be (or stay) in touch: both approved, a shared category, no block. */
export async function canConnect(me: UserDoc, other: { _id: Types.ObjectId; status: string; role: string; categoryIds: Types.ObjectId[] }) {
  return (
    other.role === "user" &&
    other.status === "approved" &&
    String(other._id) !== String(me._id) &&
    sharedCategoryIds(me, other).length > 0 &&
    !(await blockedEitherWay(me._id, other._id))
  );
}

type Other = { _id: Types.ObjectId; username: string; status: string; categoryIds: Types.ObjectId[]; lastSeenAt?: Date | null };

/**
 * Everything the contacts screen shows. A friendship whose pair no longer shares a category, or whose other side
 * isn't approved, is "paused": hidden from both until the admin fixes it.
 */
export async function contactsView(me: UserDoc) {
  const friendships = await Friendship.find({ $or: [{ userA: me._id }, { userB: me._id }] }).sort({ updatedAt: -1 }).lean();
  const others = await User.find({ _id: { $in: friendships.map((f) => otherUserId(f, me._id)) } })
    .select("username status categoryIds lastSeenAt")
    .lean<Other[]>();
  const byId = new Map(others.map((u) => [String(u._id), u]));

  const contacts = [];
  const incoming = [];
  const outgoing = [];
  for (const f of friendships) {
    const other = byId.get(String(otherUserId(f, me._id)));
    if (other?.status !== "approved" || !sharedCategoryIds(me, other).length) continue;
    if (f.status === "accepted") contacts.push(contactJson(other, f));
    else if (String(f.requestedBy) === String(me._id)) outgoing.push({ id: String(f._id), username: other.username, at: f.createdAt });
    else incoming.push({ id: String(f._id), username: other.username, at: f.createdAt });
  }
  contacts.sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  return { contacts, incoming, outgoing };
}

export function contactJson(other: Other, f: { acceptedAt?: Date | null; createdAt?: Date; via: string }) {
  return {
    id: String(other._id),
    username: other.username,
    online: presence.isOnline(other._id),
    lastSeenAt: other.lastSeenAt ?? null,
    since: f.acceptedAt ?? f.createdAt,
    via: f.via,
  };
}

/** Ids of everyone with a friendship (any state) with this user, for live updates. */
export async function relatedUserIds(userId: Types.ObjectId | string) {
  const fs = await Friendship.find({ $or: [{ userA: userId }, { userB: userId }] }).select("userA userB").lean();
  return fs.map((f) => String(otherUserId(f, userId)));
}
