import { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { conflict, notFound } from "../../lib/errors.js";
import { bus } from "../../lib/events.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth, requireUser } from "../../middleware/auth.js";
import { pair } from "../../models/friendship.js";
import { LiveSession, type LiveDoc } from "../../models/liveSession.js";
import { User, type UserDoc } from "../../models/user.js";
import { presence } from "../../realtime/presence.js";
import { notify } from "../notify/service.js";
import { pairOptions } from "../chats/service.js";
import { droppedSince, endLive, expireLive, LIVE_INVITE_MINUTES, otherOf, startRunning } from "./service.js";
import { badRequest } from "../../lib/errors.js";

const key32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "invalid key");
const sig64 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "invalid signature");
const sessionKey = z.object({ pub: key32, sig: sig64 });

/** Mounted on /api: only /api/live/… needs the user session. */
export function createLiveRouter(config: Config) {
  const router = Router();
  router.use("/live", requireUser(config));
  const me = (req: Request) => auth(req).user;

  async function openLive(req: Request, statuses: ("invited" | "active")[] = ["invited", "active"]): Promise<LiveDoc> {
    const live = await LiveSession.findOne({
      _id: new Types.ObjectId(parse(objectIdSchema, req.params.id)),
      participants: me(req)._id,
      status: { $in: statuses },
    });
    if (!live) throw notFound("This live chat has ended.");
    // The 5 minutes are exact, not "within the next minute"
    if (live.status === "invited" && live.inviteExpiresAt && live.inviteExpiresAt.getTime() < Date.now()) {
      await endLive(live, "invite_expired");
      throw notFound("This live chat has ended.");
    }
    return live;
  }

  function signedKey(user: UserDoc, key: { pub: string; sig: string }) {
    if (!user.identity?.signPub) throw conflict("Set up this device's keys first.", "no_identity");
    return { userId: user._id, pub: key.pub, sig: key.sig, identityPub: user.identity.signPub };
  }

  async function liveJson(user: UserDoc, sessions: LiveDoc[]) {
    const others = await User.find({ _id: { $in: sessions.map((s) => otherOf(s.participants, user._id)) } })
      .select("username identity")
      .lean();
    const byId = new Map(others.map((u) => [String(u._id), u]));
    return sessions.map((s) => {
      const other = byId.get(String(otherOf(s.participants, user._id)));
      const dropped = droppedSince(s.id);
      return {
        id: s.id,
        with: other
          ? { id: String(other._id), username: other.username, online: presence.isOnline(other._id), identityPub: other.identity?.signPub ?? null }
          : null,
        status: s.status,
        createdByMe: String(s.createdBy) === user.id,
        invitedAt: s.invitedAt,
        inviteExpiresAt: s.inviteExpiresAt ?? null,
        startedAt: s.startedAt ?? null,
        // Someone is waited for: who, and until when
        waitingFor: dropped ? { mine: dropped.userId === user.id, deadline: dropped.deadline } : null,
        keys: s.keys.map((k) => ({ userId: String(k.userId), pub: k.pub, sig: k.sig, identityPub: k.identityPub })),
      };
    });
  }

  router.get("/live", async (req, res) => {
    await expireLive();
    const sessions = await LiveSession.find({ participants: me(req)._id, status: { $in: ["invited", "active"] } });
    res.json({ live: await liveJson(me(req), sessions) });
  });

  router.post("/live", async (req, res) => {
    const body = parse(z.object({ userId: objectIdSchema, key: sessionKey }), req.body);
    const user = me(req);
    const options = await pairOptions(user._id, body.userId);
    if (!options) throw notFound("Contact not found");
    if (!options.live) throw badRequest("Live chat isn't available with this contact.", "mode_not_allowed");
    if (await LiveSession.exists({ pairKey: pair(user._id, body.userId).pairKey, status: { $in: ["invited", "active"] } })) {
      throw conflict("You already have a live chat with this contact.", "live_exists");
    }
    const live = await LiveSession.create({
      participants: [user._id, new Types.ObjectId(body.userId)],
      pairKey: pair(user._id, body.userId).pairKey,
      status: "invited",
      createdBy: user._id,
      categoryId: options.categoryId,
      keys: [signedKey(user, body.key)],
      inviteExpiresAt: new Date(Date.now() + LIVE_INVITE_MINUTES * 60_000),
    });
    bus.toUsers([body.userId], "live:changed");
    void notify(body.userId, {
      kind: "live_invite",
      title: user.username,
      body: `wants to chat live · ${LIVE_INVITE_MINUTES} minutes to answer`,
      tag: `live:${live.id}`,
      open: { liveId: live.id },
    });
    const [json] = await liveJson(user, [live]);
    res.status(201).json({ live: json });
  });

  router.post("/live/:id/accept", async (req, res) => {
    const { key } = parse(z.object({ key: sessionKey }), req.body);
    const user = me(req);
    const live = await openLive(req, ["invited"]);
    if (String(live.createdBy) === user.id) throw conflict("Wait for the other person to accept.");
    const options = await pairOptions(live.participants[0]!, live.participants[1]!);
    if (!options?.live) {
      await endLive(live, "rules_changed");
      throw notFound("This live chat has ended.");
    }
    live.keys.push(signedKey(user, key));
    live.status = "active";
    live.startedAt = new Date();
    live.inviteExpiresAt = undefined;
    await live.save();
    startRunning(live);
    bus.toUsers(live.participants, "live:changed");
    bus.toUsers([live.createdBy], "live:accepted", { sessionId: live.id, by: user.id });
    void notify(live.createdBy, {
      kind: "chat_accepted",
      title: user.username,
      body: "is live with you now.",
      tag: `live:${live.id}`,
      open: { liveId: live.id },
    });
    const [json] = await liveJson(user, [live]);
    res.json({ live: json });
  });

  // Declining, cancelling or leaving: all wipe it for both
  router.post("/live/:id/decline", async (req, res) => {
    const live = await openLive(req, ["invited"]);
    await endLive(live, String(live.createdBy) === me(req).id ? "cancelled" : "declined", me(req)._id);
    res.json({ ok: true });
  });

  router.delete("/live/:id", async (req, res) => {
    const live = await openLive(req);
    await endLive(live, live.status === "invited" ? "cancelled" : "left", me(req)._id);
    res.json({ ok: true });
  });

  return router;
}
