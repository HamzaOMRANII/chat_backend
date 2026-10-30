import { Types } from "mongoose";
import { bus } from "../../lib/events.js";
import { logger } from "../../lib/logger.js";
import { LiveSession, type LiveDoc } from "../../models/liveSession.js";
import { User } from "../../models/user.js";
import { presence } from "../../realtime/presence.js";
import { notify } from "../notify/service.js";
import { pairOptions } from "../chats/service.js";

/** A live invitation stays open this long. */
export const LIVE_INVITE_MINUTES = 5;
/** Someone whose connection drops has this long to come back before the live chat is wiped. */
export const LIVE_DROP_SECONDS = 60;
/** Milliseconds; a variable only so tests can shorten it. */
export const liveTiming = { dropMs: LIVE_DROP_SECONDS * 1000 };
const ENDED_KEEP_DAYS = 30;

const ENDED_TEXT: Record<string, string> = {
  declined: "declined your live invitation",
  cancelled: "cancelled the live invitation",
  left: "left. Everything was wiped on both phones.",
  connection_lost: "lost connection for 1 minute. Everything was wiped on both phones.",
  invite_expired: "The live invitation expired without an answer.",
};

/** Sessions that are running: who is in them, so each typed line is relayed without a database read. */
const running = new Map<string, string[]>();
/** Someone who dropped: the timer that wipes the session unless they come back. */
const drops = new Map<string, { userId: string; deadline: number; timer: NodeJS.Timeout }>();

export const otherOf = (participants: (Types.ObjectId | string)[], userId: Types.ObjectId | string) => participants.find((p) => String(p) !== String(userId))!;

export function startRunning(live: LiveDoc) {
  running.set(live.id, live.participants.map(String));
}

/** The other person of a running live chat, or null (not running, or not a participant). */
export async function peerOf(sessionId: string, userId: string): Promise<string | null> {
  let people = running.get(sessionId);
  if (!people) {
    const live = await LiveSession.findOne({ _id: sessionId, status: "active" }).select("participants").lean();
    if (!live) return null;
    people = live.participants.map(String);
    running.set(sessionId, people);
  }
  return people.includes(userId) ? String(otherOf(people, userId)) : null;
}

/** When someone is waited for: the deadline (ms) of a dropped participant, if any. */
export const droppedSince = (sessionId: string) => drops.get(sessionId) ?? null;

/** Ends a live chat for both at once; nothing was ever stored but the metadata. */
export async function endLive(live: LiveDoc, reason: string, by?: Types.ObjectId | null) {
  if (live.status === "ended") return;
  live.status = "ended";
  live.endedAt = new Date();
  live.endedBy = by ?? undefined;
  live.endReason = reason;
  live.purgeAt = new Date(Date.now() + ENDED_KEEP_DAYS * 24 * 3600_000);
  live.set("keys", []);
  await live.save();
  running.delete(live.id);
  const drop = drops.get(live.id);
  if (drop) clearTimeout(drop.timer);
  drops.delete(live.id);
  bus.toUsers(live.participants, "live:ended", { sessionId: live.id, reason, by: by ? String(by) : null });

  const people = await User.find({ _id: { $in: live.participants } })
    .select("username")
    .lean();
  for (const userId of live.participants) {
    if (by && String(userId) === String(by)) continue;
    const who = people.find((p) => String(p._id) === String(otherOf(live.participants, userId)))?.username ?? "Your contact";
    const text = ENDED_TEXT[reason] ?? "ended the live chat. Everything was wiped.";
    const expired = reason === "invite_expired";
    void notify(userId, {
      kind: reason === "declined" ? "chat_declined" : "chat_ended",
      title: expired ? "Live invitation expired" : who,
      body: text,
      tag: `live:${live.id}`,
      open: {},
    });
  }
}

/** The last socket of this user closed: their running live chats are wiped in 1 minute unless they come back. */
export async function userDropped(userId: string) {
  const live = await LiveSession.find({ participants: userId, status: "active" });
  for (const session of live) {
    if (drops.has(session.id)) continue;
    const deadline = Date.now() + liveTiming.dropMs;
    const timer = setTimeout(() => {
      void LiveSession.findOne({ _id: session._id, status: "active" })
        .then(async (s) => {
          if (s && !presence.isOnline(userId)) await endLive(s, "connection_lost", null);
        })
        .catch((err) => logger.error({ err }, "live wipe failed"));
    }, liveTiming.dropMs);
    drops.set(session.id, { userId, deadline, timer });
    bus.toUsers([otherOf(session.participants, userId)], "live:peer", { sessionId: session.id, online: false, deadline });
  }
}

/** They are back within the minute. */
export async function userBack(userId: string) {
  for (const [sessionId, drop] of drops) {
    if (drop.userId !== userId) continue;
    clearTimeout(drop.timer);
    drops.delete(sessionId);
    const people = running.get(sessionId) ?? (await peerOf(sessionId, userId).then(() => running.get(sessionId)));
    if (people) bus.toUsers([otherOf(people, userId)], "live:peer", { sessionId, online: true });
  }
}

/** Every minute: invitations nobody answered in 5 minutes expire. */
export async function expireLive() {
  for (const live of await LiveSession.find({ status: "invited", inviteExpiresAt: { $lt: new Date() } })) await endLive(live, "invite_expired");
}

/** The server restarted: running live chats lost their relay and their timers, so they end. */
export async function resetLive() {
  for (const live of await LiveSession.find({ status: { $in: ["invited", "active"] } })) await endLive(live, "connection_lost");
}

/** Called after anything that can change what contacts may do: live chats that no longer fit the rules end. */
export async function reconcileLive(userIds: (Types.ObjectId | string)[]) {
  const ids = [...new Set(userIds.map(String))].map((id) => new Types.ObjectId(id));
  if (!ids.length) return 0;
  let ended = 0;
  for (const live of await LiveSession.find({ participants: { $in: ids }, status: { $in: ["invited", "active"] } })) {
    const options = await pairOptions(live.participants[0]!, live.participants[1]!);
    if (!options?.live) {
      await endLive(live, options ? "rules_changed" : "contact_unavailable");
      ended++;
    }
  }
  return ended;
}
