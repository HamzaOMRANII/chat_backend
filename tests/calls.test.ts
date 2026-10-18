import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { io as connect, type Socket } from "socket.io-client";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Call } from "../src/models/call.js";
import { FcmToken } from "../src/models/fcmToken.js";
import { createRealtime } from "../src/realtime/index.js";
import { callTiming } from "../src/modules/calls/service.js";
import { approvedUser, config, connectTestDb, device, fakeMailer, PASSWORD, resetTestDb } from "./helpers.js";

let server: Server;
let url: string;
const mail = fakeMailer();
beforeAll(async () => {
  await connectTestDb();
  server = createServer(createApp(config, mail.mailer));
  createRealtime(server, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await mongoose.disconnect();
});
beforeEach(resetTestDb);

async function person(username: string, categories = ["Friends"]) {
  const user = await approvedUser(username, categories);
  const dev = device({ platform: "android" });
  const step1 = await request(url).post("/api/auth/login").set("X-Client", "android").send({ username, password: PASSWORD, device: dev });
  const step2 = await request(url).post("/api/auth/verify-code").set("X-Client", "android").send({ challengeId: step1.body.challengeId, code: mail.lastCode() });
  const token = step2.body.token as string;
  const api = (method: "get" | "post" | "put", path: string, body?: object) => request(url)[method](path).set("Authorization", `Bearer ${token}`).set("X-Client", "android").send(body);
  await api("put", "/api/keys/identity", { deviceId: dev.deviceId, signPub: randomBytes(32).toString("base64") }).expect(200);
  return { id: user.id as string, token, api };
}
async function contacts(categories = ["Externals"]) {
  const a = await person("hamza", categories);
  const b = await person("leila.b", categories);
  const { code } = (await a.api("post", "/api/contacts/invite")).body;
  await b.api("post", "/api/contacts/add", { inviteCode: code }).expect(200);
  return { a, b };
}
const socketOf = async (token: string) => {
  const s = connect(url, { path: "/socket.io", auth: { token }, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => (s.on("connect", () => resolve()), s.on("connect_error", reject)));
  return s;
};
const next = <T>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));
const ask = <T>(s: Socket, event: string, payload: object) => new Promise<T>((resolve) => s.emit(event, payload, resolve));

describe("calls", () => {
  it("ring, are answered, relay the WebRTC signals, and end for both (any category, Externals too)", async () => {
    const { a, b } = await contacts();
    const sa = await socketOf(a.token);
    const sb = await socketOf(b.token);
    const incoming = next<{ callId: string; kind: string; from: { username: string } }>(sb, "call:incoming");
    const started = await ask<{ callId: string; peer: { username: string } }>(sa, "call:start", { to: b.id, kind: "video" });
    expect(started.peer.username).toBe("leila.b");
    expect(await incoming).toMatchObject({ callId: started.callId, kind: "video", from: { username: "hamza" } });

    const answered = next(sa, "call:answered");
    expect(await ask(sb, "call:answer", { callId: started.callId })).toEqual({ ok: true });
    await answered;
    const signal = next<{ from: string; data: unknown }>(sb, "call:signal");
    sa.emit("call:signal", { callId: started.callId, to: b.id, data: { sdp: { type: "offer", sdp: "v=0" }, sig: "x" } });
    expect(await signal).toMatchObject({ from: a.id, data: { sdp: { type: "offer" } } });

    const ended = next<{ reason: string }>(sb, "call:ended");
    sa.emit("call:leave", { callId: started.callId });
    expect(await ended).toMatchObject({ reason: "hung_up" });
    expect((await Call.findById(started.callId))!.status).toBe("ended");
    [sa, sb].forEach((s) => s.close());
  });

  it("tell the caller when the other person isn't taking calls, is offline or busy", async () => {
    const { a, b } = await contacts(["Friends"]);
    const sa = await socketOf(a.token);
    expect(await ask(sa, "call:start", { to: b.id, kind: "voice" })).toEqual({ error: "offline" });
    // App closed but registered with Firebase: it rings through the notification
    await b.api("post", "/api/notifications/fcm", { token: "t".repeat(160) }).expect(200);
    const rung = await ask<{ callId?: string }>(sa, "call:start", { to: b.id, kind: "voice" });
    expect(rung.callId).toBeTruthy();
    sa.emit("call:leave", { callId: rung.callId });
    await new Promise((r) => setTimeout(r, 200));
    await FcmToken.deleteMany({});
    await b.api("put", "/api/me/calls", { receive: false }).expect(200);
    expect((await b.api("get", "/api/me/calls")).body).toEqual({ receive: false });
    const sb = await socketOf(b.token);
    expect(await ask(sa, "call:start", { to: b.id, kind: "voice" })).toEqual({ error: "not_taking_calls" });
    await b.api("put", "/api/me/calls", { receive: true });
    const first = await ask<{ callId: string }>(sa, "call:start", { to: b.id, kind: "voice" });
    expect(first.callId).toBeTruthy();
    expect(await ask(sb, "call:start", { to: a.id, kind: "voice" })).toEqual({ error: "busy" });
    [sa, sb].forEach((s) => s.close());
  });

  it("are missed after ringing unanswered", async () => {
    callTiming.ringMs = 300;
    try {
      const { a, b } = await contacts(["Friends"]);
      const sa = await socketOf(a.token);
      const sb = await socketOf(b.token);
      const ended = next<{ reason: string }>(sa, "call:ended");
      await ask(sa, "call:start", { to: b.id, kind: "voice" });
      expect(await ended).toMatchObject({ reason: "missed" });
      [sa, sb].forEach((s) => s.close());
    } finally {
      callTiming.ringMs = 45_000;
    }
  });

  it("give short-lived TURN credentials for the relay", async () => {
    const { a } = await contacts(["Friends"]);
    const turn = (await a.api("get", "/api/calls/turn")).body;
    expect(turn.username).toMatch(new RegExp(`^\\d+:${a.id}$`));
    expect(turn.credential).toBe(createHmac("sha1", config.TURN_SECRET).update(turn.username).digest("base64"));
    expect(turn.urls.some((u: string) => u.startsWith("turn:"))).toBe(true);
  });

  it("in a group: everyone is rung, newcomers learn who is in, only the starter ends it for everyone", async () => {
    const a = await person("hamza", ["Friends"]);
    const b = await person("leila.b", ["Friends"]);
    const c = await person("rami.t", ["Friends"]);
    const { Group } = await import("../src/models/group.js");
    const { Category } = await import("../src/models/category.js");
    const cat = (await Category.findOne({ name: "Friends" }))!;
    const group = await Group.create({ name: "Site team", status: "active", categoryId: cat._id, mode: "keep", retentionMinutes: 1440, members: [a.id, b.id, c.id] });
    const [sa, sb, sc] = await Promise.all([socketOf(a.token), socketOf(b.token), socketOf(c.token)]);
    const ringB = next<{ callId: string; group: { name: string } }>(sb, "call:incoming");
    const ringC = next(sc, "call:incoming");
    const started = await ask<{ callId: string }>(sa, "call:start", { groupId: group.id, kind: "voice" });
    expect((await ringB).group.name).toBe("Site team");
    await ringC;

    const aSeesB = next<{ user: { username: string } }>(sa, "call:joined");
    expect(await ask(sb, "call:join", { callId: started.callId })).toMatchObject({ ok: true, joined: [{ username: "hamza" }] });
    expect((await aSeesB).user.username).toBe("leila.b");
    const joinedC = await ask<{ joined: { username: string }[] }>(sc, "call:join", { callId: started.callId });
    expect(joinedC.joined.map((j) => j.username).sort()).toEqual(["hamza", "leila.b"]);

    // leila.b can't end it for everyone: she just leaves
    const cSeesLeft = next<{ userId: string }>(sc, "call:left");
    sb.emit("call:leave", { callId: started.callId, everyone: true });
    expect((await cSeesLeft).userId).toBe(b.id);
    // hamza, who started it, ends it for everyone
    const ended = next<{ reason: string }>(sc, "call:ended");
    sa.emit("call:leave", { callId: started.callId, everyone: true });
    expect(await ended).toMatchObject({ reason: "ended_by_starter" });
    [sa, sb, sc].forEach((s) => s.close());
  });
});
