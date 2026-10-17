import webpush from "web-push";
import type { Types } from "mongoose";
import type { Config } from "../../config/env.js";
import { bus } from "../../lib/events.js";
import { logger } from "../../lib/logger.js";
import { PushSubscription } from "../../models/pushSubscription.js";
import { User } from "../../models/user.js";
import { presence } from "../../realtime/presence.js";
import { sendFcm } from "./fcm.js";

export type NotifyKind = "contact_request" | "contact_added" | "chat_invite" | "chat_accepted" | "chat_declined" | "chat_ended" | "live_invite" | "media_request" | "export_request" | "export_answer" | "call" | "message";
/** Which setting turns each kind's system notification on or off. */
const PREF: Record<NotifyKind, "messages" | "chats" | "contacts"> = {
  contact_request: "contacts",
  contact_added: "contacts",
  chat_invite: "chats",
  chat_accepted: "chats",
  chat_declined: "chats",
  chat_ended: "chats",
  live_invite: "chats",
  media_request: "chats",
  export_request: "chats",
  export_answer: "chats",
  call: "chats",
  message: "messages",
};

/**
 * What the person sees. Never any message content: messages are end-to-end encrypted and the server can't read them.
 * `open` tells the app where a tap leads.
 */
export type Notification = {
  kind: NotifyKind;
  title: string;
  body: string;
  /** Same tag = replaces the previous notification (one per chat for messages). */
  tag: string;
  open: { chatId?: string; userId?: string; liveId?: string; media?: boolean };
  /** False when the person turned this kind off: in-app banner only, no system notification. */
  system: boolean;
};

let pushReady = false;
export function configurePush(config: Config) {
  pushReady = Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
  if (pushReady) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!);
}

/** Open apps get it on the socket (they show a banner, or a phone notification when in the background); browsers that aren't on screen get a Web Push. */
export async function notify(userId: Types.ObjectId | string, n: Omit<Notification, "system">) {
  try {
    const user = await User.findById(userId).select("notify activeSessionId status").lean();
    if (!user || user.status !== "approved") return;
    const system = user.notify?.[PREF[n.kind]] !== false;
    bus.toUsers([userId], "notify", { ...n, system });
    if (!system || !user.activeSessionId || presence.onScreen(user.activeSessionId)) return;
    // Android app closed or in the background: Firebase (generic text only)
    void sendFcm(String(user.activeSessionId), { kind: n.kind, tag: n.tag, url: openUrl(n.open), body: n.body }).catch((err) => logger.warn({ err }, "firebase failed"));
    if (!pushReady) return;
    const subs = await PushSubscription.find({ userId, sessionId: user.activeSessionId }).lean();
    const payload = JSON.stringify({ title: n.title, body: n.body, tag: n.tag, url: openUrl(n.open) });
    await Promise.all(
      subs.map((s) =>
        webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600, urgency: "high" }).catch(async (err: { statusCode?: number }) => {
          // The browser dropped the subscription
          if (err.statusCode === 404 || err.statusCode === 410) await PushSubscription.deleteOne({ _id: s._id });
          else logger.warn({ status: err.statusCode }, "web push failed");
        }),
      ),
    );
  } catch (err) {
    logger.error({ err }, "notification failed");
  }
}

/** Where a tap on a browser notification opens the app. */
export const openUrl = (open: Notification["open"]) => (open.chatId ? `/#chat=${open.chatId}` : open.liveId ? `/#live=${open.liveId}` : open.media ? "/#media=all" : open.userId ? `/#contact=${open.userId}` : "/");

/** "30 min", "6 hours", "2 days" */
export const retentionText = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${minutes / 60} hour${minutes > 60 ? "s" : ""}` : `${minutes / 1440} day${minutes > 1440 ? "s" : ""}`;
