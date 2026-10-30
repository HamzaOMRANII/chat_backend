import { Router, type Request } from "express";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { parse } from "../../lib/validate.js";
import { logger } from "../../lib/logger.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { PushSubscription } from "../../models/pushSubscription.js";
import { FcmToken } from "../../models/fcmToken.js";

const b64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+={0,2}$/)
  .max(200);
const subscription = z.object({ endpoint: z.url().startsWith("https://").max(1000), keys: z.object({ p256dh: b64url, auth: b64url }) });
const prefs = z.object({ messages: z.boolean(), chats: z.boolean(), contacts: z.boolean() }).partial();

/** Mounted on /api: notification settings and this browser's Web Push subscription. */
export function createNotifyRouter(config: Config) {
  const router = Router();
  router.use("/notifications", requireUser(config));
  const me = (req: Request) => auth(req).user;

  router.get("/notifications", (req, res) => {
    const n = me(req).notify;
    res.json({
      prefs: { messages: n?.messages !== false, chats: n?.chats !== false, contacts: n?.contacts !== false },
      // Browsers subscribe with this key; null = Web Push is off on this server
      pushKey: config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY ? config.VAPID_PUBLIC_KEY : null,
    });
  });

  router.put("/notifications", async (req, res) => {
    const body = parse(prefs, req.body);
    const user = me(req);
    user.set("notify", { messages: user.notify?.messages !== false, chats: user.notify?.chats !== false, contacts: user.notify?.contacts !== false, ...body });
    await user.save();
    res.json({ prefs: user.notify });
  });

  router.post("/notifications/push", async (req, res) => {
    const sub = parse(subscription, req.body);
    const { user, session } = auth(req);
    await PushSubscription.findOneAndUpdate(
      { endpoint: sub.endpoint },
      { userId: user._id, sessionId: session._id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      { upsert: true },
    );
    res.json({ ok: true });
  });

  // The Android app's Firebase token, for this session only
  router.post("/notifications/fcm", async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(4096) }), req.body);
    const { user, session } = auth(req);
    await FcmToken.findOneAndUpdate({ token }, { userId: user._id, sessionId: session._id, token }, { upsert: true });
    res.json({ ok: true });
  });
  // What the phone says about its Firebase registration (to find out why notifications don't arrive)
  router.post("/notifications/fcm-status", (req, res) => {
    const body = parse(z.object({ state: z.enum(["off", "on", "error"]), detail: z.string().max(300).default("") }), req.body);
    logger.info({ user: me(req).username, platform: auth(req).session.device?.platform, ...body }, "firebase registration on the phone");
    res.json({ ok: true });
  });
  router.delete("/notifications/fcm", async (req, res) => {
    const { token } = parse(z.object({ token: z.string().max(4096) }), req.body);
    await FcmToken.deleteOne({ token, userId: me(req)._id });
    res.json({ ok: true });
  });

  router.delete("/notifications/push", async (req, res) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    await PushSubscription.deleteOne({ endpoint, userId: me(req)._id });
    res.json({ ok: true });
  });

  return router;
}
