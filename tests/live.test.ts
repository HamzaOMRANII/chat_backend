import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { io as connect, type Socket } from "socket.io-client";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Category } from "../src/models/category.js";
import { LiveSession } from "../src/models/liveSession.js";
import { createRealtime } from "../src/realtime/index.js";
import { expireLive, liveTiming } from "../src/modules/live/service.js";
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

const b64 = (n: number) => randomBytes(n).toString("base64");
const key = () => ({ pub: b64(32), sig: b64(64) });

/** Android-style sign-in (token), with the device's identity key published. */
async function person(username: string) {
  const dev = device({ platform: "android" });
  const step1 = await request(url).post("/api/auth/login").set("X-Client", "android").send({ username, password: PASSWORD, device: dev });
  const step2 = await request(url)
    .post("/api/auth/verify-code")
    .set("X-Client", "android")
    .send({ challengeId: step1.body.challengeId, code: mail.lastCode() });
  const token = step2.body.token as string;
  const api = (method: "get" | "post" | "put" | "delete", path: string, body?: object) =>
    request(url)[method](path).set("Authorization", `Bearer ${token}`).set("X-Client", "android").send(body);
  await api("put", "/api/keys/identity", { deviceId: dev.deviceId, signPub: b64(32) }).expect(200);
  return { token, api };
}

async function pairUp(categoriesA = ["Friends"], categoriesB = ["Friends"]) {
  const a = await approvedUser("hamza", categoriesA);
  const b = await approvedUser("leila.b", categoriesB);
  const pa = await person("hamza");
  const pb = await person("leila.b");
  const { code } = (await pa.api("post", "/api/contacts/invite")).body;
  await pb.api("post", "/api/contacts/add", { inviteCode: code }).expect(200);
  return { a, b, pa, pb };
}

const socketOf = async (token: string) => {
  const socket = connect(url, { path: "/socket.io", auth: { token }, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => (socket.on("connect", () => resolve()), socket.on("connect_error", reject)));
  return socket;
};
const next = <T>(socket: Socket, event: string) => new Promise<T>((resolve) => socket.once(event, resolve));

describe("live invitations", () => {
  it("are answered within 5 minutes, and can run next to a stored chat", async () => {
    const { b, pa, pb } = await pairUp();
    await pa.api("post", "/api/chats", { userId: b.id, mode: "keep", retentionMinutes: 1440, key: key() }).expect(201);
    const invite = await pa.api("post", "/api/live", { userId: b.id, key: key() });
    expect(invite.status).toBe(201);
    const minutes = (new Date(invite.body.live.inviteExpiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4.9);
    expect(minutes).toBeLessThanOrEqual(5);

    expect((await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.code).toBe("live_exists");
    expect((await pb.api("get", "/api/live")).body.live).toMatchObject([{ status: "invited", createdByMe: false, with: { username: "hamza" } }]);

    const accepted = await pb.api("post", `/api/live/${invite.body.live.id}/accept`, { key: key() });
    expect(accepted.body.live.status).toBe("active");
    expect(accepted.body.live.keys).toHaveLength(2);
  });

  it("expire after 5 minutes; declining and cancelling end them", async () => {
    const { b, pa, pb } = await pairUp();
    const first = (await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.live.id;
    await LiveSession.updateOne({ _id: first }, { inviteExpiresAt: new Date(Date.now() - 1000) });
    await expireLive();
    expect((await LiveSession.findById(first))!.endReason).toBe("invite_expired");

    const second = (await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.live.id;
    await pb.api("post", `/api/live/${second}/decline`).expect(200);
    expect((await LiveSession.findById(second))!.endReason).toBe("declined");
    const third = (await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.live.id;
    await pa.api("post", `/api/live/${third}/decline`).expect(200);
    expect((await LiveSession.findById(third))!.endReason).toBe("cancelled");
  });

  it("need a category that allows live", async () => {
    const { b, pa } = await pairUp(["Externals"], ["Externals"]);
    expect((await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.code).toBe("mode_not_allowed");
  });

  it("end when the rules stop allowing live", async () => {
    const { b, pa, pb } = await pairUp();
    const id = (await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.live.id;
    await pb.api("post", `/api/live/${id}/accept`, { key: key() }).expect(200);
    await Category.updateOne({ name: "Friends" }, { "rules.modes": ["keep"] });
    const { reconcileAllChats } = await import("../src/modules/chats/service.js");
    await reconcileAllChats();
    expect((await LiveSession.findById(id))!.endReason).toBe("rules_changed");
  });
});

describe("a running live chat", () => {
  it("relays what is typed to the other side and stores nothing", async () => {
    const { b, pa, pb } = await pairUp();
    const id = (await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.live.id;
    await pb.api("post", `/api/live/${id}/accept`, { key: key() }).expect(200);
    const sa = await socketOf(pa.token);
    const sb = await socketOf(pb.token);
    const got = next<{ sessionId: string; nonce: string; ct: string }>(sb, "live");
    const payload = { sessionId: id, nonce: b64(24), ct: b64(60) };
    sa.emit("live", payload);
    expect(await got).toEqual(payload);

    // An outsider's lines go nowhere
    const eve = await approvedUser("eve");
    void eve;
    const se = await socketOf((await person("eve")).token);
    let leaked = false;
    sb.on("live", () => (leaked = true));
    se.emit("live", { sessionId: id, nonce: b64(24), ct: b64(10) });
    await new Promise((r) => setTimeout(r, 200));
    expect(leaked).toBe(false);
    expect(Object.keys((await LiveSession.findById(id).lean())!)).not.toContain("ct");
    [sa, sb, se].forEach((s) => s.close());
  });

  it("leaving ends it for both at once", async () => {
    const { b, pa, pb } = await pairUp();
    const id = (await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.live.id;
    await pb.api("post", `/api/live/${id}/accept`, { key: key() }).expect(200);
    const sa = await socketOf(pa.token);
    const ended = next<{ reason: string }>(sa, "live:ended");
    await pb.api("delete", `/api/live/${id}`).expect(200);
    expect(await ended).toMatchObject({ reason: "left" });
    expect((await LiveSession.findById(id))!.keys).toHaveLength(0);
    sa.close();
  });

  it("waits for a dropped connection, then wipes", async () => {
    liveTiming.dropMs = 400;
    try {
      const { b, pa, pb } = await pairUp();
      const id = (await pa.api("post", "/api/live", { userId: b.id, key: key() })).body.live.id;
      await pb.api("post", `/api/live/${id}/accept`, { key: key() }).expect(200);
      const sa = await socketOf(pa.token);
      let sb = await socketOf(pb.token);

      // Back in time: nothing happens
      const away = next<{ online: boolean }>(sa, "live:peer");
      sb.close();
      expect(await away).toMatchObject({ online: false });
      const back = next<{ online: boolean }>(sa, "live:peer");
      sb = await socketOf(pb.token);
      expect(await back).toMatchObject({ online: true });
      await new Promise((r) => setTimeout(r, 600));
      expect((await LiveSession.findById(id))!.status).toBe("active");

      // Not back in time: wiped
      const ended = next<{ reason: string }>(sa, "live:ended");
      sb.close();
      expect(await ended).toMatchObject({ reason: "connection_lost" });
      expect((await LiveSession.findById(id))!.status).toBe("ended");
      sa.close();
    } finally {
      liveTiming.dropMs = 60_000;
    }
  });
});
