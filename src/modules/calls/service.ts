import { createHmac } from "node:crypto";
import type { Config } from "../../config/env.js";
import { bus } from "../../lib/events.js";
import { logger } from "../../lib/logger.js";
import { Call } from "../../models/call.js";
import { User } from "../../models/user.js";
import { presence } from "../../realtime/presence.js";
import { pairOptions } from "../chats/service.js";
import { notify } from "../notify/service.js";

/** A call rings this long, and a participant whose connection drops has this long to come back. */
export const callTiming = { ringMs: 45_000, dropMs: 30_000 };
const KEEP_DAYS = 30;

/** Short-lived TURN credentials (coturn use-auth-secret): username "<expiry>:<userId>", HMAC-SHA1 of it. */
export function turnCredentials(config: Config, userId: string) {
  const username = `${Math.floor(Date.now() / 1000) + 3600}:${userId}`;
  const credential = createHmac("sha1", config.TURN_SECRET).update(username).digest("base64");
  return { urls: config.TURN_URLS, username, credential, ttl: 3600 };
}

type Running = { participants: string[]; startedBy: string; kind: "voice" | "video"; active: boolean; timer?: NodeJS.Timeout };
/** Calls in progress: who is in them (signals are relayed without a database read). Several people are possible. */
const running = new Map<string, Running>();
const drops = new Map<string, NodeJS.Timeout>();

export const inCall = (userId: string) => [...running.values()].some((c) => c.participants.includes(userId));
export const callOf = (callId: string, userId: string) => {
  const c = running.get(callId);
  return c && c.participants.includes(userId) ? c : null;
};

export async function endCall(callId: string, reason: string, by?: string | null) {
  const c = running.get(callId);
  if (!c) return;
  running.delete(callId);
  if (c.timer) clearTimeout(c.timer);
  const call = await Call.findById(callId);
  if (call && call.status !== "ended") {
    call.status = "ended";
    call.endedAt = new Date();
    call.endReason = reason;
    if (by) call.set("endedBy", by);
    call.purgeAt = new Date(Date.now() + KEEP_DAYS * 864e5);
    await call.save();
  }
  bus.toUsers(c.participants, "call:ended", { callId, reason, by: by ?? null });
  if (reason === "missed") {
    const caller = await User.findById(c.startedBy).select("username").lean();
    for (const p of c.participants.filter((p) => p !== c.startedBy)) {
      void notify(p, { kind: "call", title: caller?.username ?? "Missed call", body: `Missed ${c.kind} call`, tag: `call:${callId}`, open: { userId: c.startedBy } });
    }
  }
}

export type StartResult = { callId: string; peer: { id: string; username: string; identityPub: string | null } } | { error: "not_contact" | "not_taking_calls" | "offline" | "busy" };

/** Rings the other person, if they're a contact in good standing, reachable and taking calls. */
export async function startCall(fromId: string, toId: string, kind: "voice" | "video"): Promise<StartResult> {
  if (fromId === toId || !(await pairOptions(fromId, toId))) return { error: "not_contact" };
  const [from, to] = await Promise.all([User.findById(fromId).select("username identity").lean(), User.findById(toId).select("username identity receiveCalls").lean()]);
  if (!from || !to) return { error: "not_contact" };
  if (to.receiveCalls === false) return { error: "not_taking_calls" };
  if (!presence.isOnline(toId)) return { error: "offline" };
  if (inCall(toId) || inCall(fromId)) return { error: "busy" };
  const call = await Call.create({ participants: [fromId, toId], startedBy: fromId, kind, status: "ringing" });
  const id = call.id as string;
  running.set(id, { participants: [fromId, toId], startedBy: fromId, kind, active: false, timer: setTimeout(() => void endCall(id, "missed").catch(() => {}), callTiming.ringMs) });
  bus.toUsers([toId], "call:incoming", { callId: id, kind, from: { id: fromId, username: from.username, identityPub: from.identity?.signPub ?? null } });
  void notify(toId, { kind: "call", title: from.username, body: `Incoming ${kind} call`, tag: `call:${id}`, open: { userId: fromId } });
  return { callId: id, peer: { id: toId, username: to.username, identityPub: to.identity?.signPub ?? null } };
}

export async function answerCall(callId: string, userId: string) {
  const c = callOf(callId, userId);
  if (!c || c.active || userId === c.startedBy) return false;
  c.active = true;
  if (c.timer) clearTimeout(c.timer);
  await Call.updateOne({ _id: callId }, { status: "active", answeredAt: new Date() });
  bus.toUsers(c.participants.filter((p) => p !== userId), "call:answered", { callId, by: userId });
  return true;
}

/** Leaving: in a call of two it ends for both; in a group only the one who started it can end it for everyone. */
export async function leaveCall(callId: string, userId: string, everyone = false) {
  const c = callOf(callId, userId);
  if (!c) return;
  if (!c.active && userId !== c.startedBy) return endCall(callId, "declined", userId);
  if (c.participants.length <= 2 || (everyone && userId === c.startedBy)) return endCall(callId, c.active ? "hung_up" : "cancelled", userId);
  c.participants = c.participants.filter((p) => p !== userId);
  bus.toUsers(c.participants, "call:left", { callId, userId });
}

/** The last connection of this user closed: their calls end unless they come back in 30 s. */
export function userDropped(userId: string) {
  for (const [callId, c] of running) {
    if (!c.participants.includes(userId) || drops.has(`${callId}:${userId}`)) continue;
    drops.set(
      `${callId}:${userId}`,
      setTimeout(() => {
        drops.delete(`${callId}:${userId}`);
        if (!presence.isOnline(userId)) void leaveCall(callId, userId).catch((err) => logger.error({ err }, "call drop failed"));
      }, callTiming.dropMs),
    );
  }
}
/** A device that just connected (the app opened from the call notification) still gets the ringing call. */
export async function ringAgain(userId: string, emit: (payload: unknown) => void) {
  for (const [callId, c] of running) {
    if (c.active || c.startedBy === userId || !c.participants.includes(userId)) continue;
    const from = await User.findById(c.startedBy).select("username identity").lean();
    emit({ callId, kind: c.kind, from: { id: c.startedBy, username: from?.username ?? "?", identityPub: from?.identity?.signPub ?? null } });
  }
}

export function userBack(userId: string) {
  for (const [key, timer] of drops) {
    if (!key.endsWith(`:${userId}`)) continue;
    clearTimeout(timer);
    drops.delete(key);
  }
}

/** The server restarted: calls it was setting up are over (the media may still flow, but nobody can be reached). */
export async function resetCalls() {
  await Call.updateMany({ status: { $ne: "ended" } }, { status: "ended", endedAt: new Date(), endReason: "server_restart", purgeAt: new Date(Date.now() + KEEP_DAYS * 864e5) });
}
