import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import request from "supertest";
import webpush from "web-push";
import { io as connect } from "socket.io-client";
import { createApp } from "../src/app.js";
import { createRealtime } from "../src/realtime/index.js";
import { PushSubscription } from "../src/models/pushSubscription.js";
import { approvedUser, config, connectTestDb, device, fakeMailer, PASSWORD, resetTestDb } from "./helpers.js";

// Web Push on, with the push service replaced by a spy
const vapid = webpush.generateVAPIDKeys();
const pushConfig = { ...config, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
const pushed = vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} });

let server: Server;
let url: string;
const mail = fakeMailer();

beforeAll(async () => {
  await connectTestDb();
  server = createServer(createApp(pushConfig, mail.mailer));
  createRealtime(server, pushConfig);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await mongoose.disconnect();
});
beforeEach(async () => {
  await resetTestDb();
  pushed.mockClear();
});

async function appSignIn(username: string) {
  const dev = device({ platform: "android" });
  const step1 = await request(url).post("/api/auth/login").set("X-Client", "android").send({ username, password: PASSWORD, device: dev });
  const step2 = await request(url).post("/api/auth/verify-code").set("X-Client", "android").send({ challengeId: step1.body.challengeId, code: mail.lastCode() });
  const token = step2.body.token as string;
  const as = { Authorization: `Bearer ${token}`, "X-Client": "android" };
  await request(url).put("/api/keys/identity").set(as).send({ deviceId: dev.deviceId, signPub: Buffer.alloc(32, 1).toString("base64") }).expect(200);
  return { token, as };
}

function openSocket(token: string, visible = true) {
  const socket = connect(url, { path: "/socket.io", auth: { token, visible }, transports: ["websocket"] });
  return new Promise<typeof socket>((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

type Note = { kind: string; title: string; body: string; open: { chatId?: string }; system: boolean };
const next = (socket: Awaited<ReturnType<typeof openSocket>>, kind: string) =>
  new Promise<Note>((resolve) => {
    const on = (n: Note) => n.kind === kind && (socket.off("notify", on), resolve(n));
    socket.on("notify", on);
  });

// Notifications go out just after the response
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const pushes = (n: number) => vi.waitFor(() => expect(pushed).toHaveBeenCalledTimes(n));

const b64 = (n: number) => Buffer.alloc(n, 7).toString("base64");
const key = () => ({ pub: b64(32), sig: b64(64) });
const subscription = (n: number) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

it("tells the other side about every event, without message content", async () => {
  await approvedUser("hamza");
  const leila = await approvedUser("leila.b");
  const hamza = await appSignIn("hamza");
  const leilaApp = await appSignIn("leila.b");
  const leilaSocket = await openSocket(leilaApp.token);
  const hamzaSocket = await openSocket(hamza.token);

  const request1 = next(leilaSocket, "contact_request");
  await request(url).post("/api/contacts/add").set(hamza.as).send({ personalId: leila.personalId }).expect(200);
  expect(await request1).toMatchObject({ title: "hamza", body: "wants to connect with you", system: true });

  const added = next(hamzaSocket, "contact_added");
  const requestId = (await request(url).get("/api/contacts").set(leilaApp.as)).body.incoming[0].id;
  await request(url).post(`/api/contacts/requests/${requestId}/accept`).set(leilaApp.as).expect(200);
  expect((await added).title).toBe("leila.b");

  const invited = next(leilaSocket, "chat_invite");
  const chatId = (await request(url).post("/api/chats").set(hamza.as).send({ userId: leila.id, mode: "keep", retentionMinutes: 30, key: key() })).body.chat.id;
  expect(await invited).toMatchObject({ title: "hamza", body: expect.stringContaining("30 min"), open: { chatId } });

  // The inviter's app opens the chat by itself
  const opened = new Promise<{ chatId: string }>((resolve) => hamzaSocket.once("chat:accepted", resolve));
  const acceptedNote = next(hamzaSocket, "chat_accepted");
  await request(url).post(`/api/chats/${chatId}/accept`).set(leilaApp.as).send({ key: key() }).expect(200);
  expect((await opened).chatId).toBe(chatId);
  expect((await acceptedNote).open.chatId).toBe(chatId);

  const message = next(leilaSocket, "message");
  await request(url).post(`/api/chats/${chatId}/messages`).set(hamza.as).send({ ciphertext: b64(40), nonce: b64(24), senderKeyVersion: 1, recipientKeyVersion: 1 }).expect(201);
  expect(await message).toMatchObject({ title: "hamza", body: "New message" });

  const ended = next(hamzaSocket, "chat_ended");
  await request(url).delete(`/api/chats/${chatId}`).set(leilaApp.as).expect(200);
  expect((await ended).body).toMatch(/ended the chat/);

  // On screen everywhere: no Web Push at all
  await settle();
  expect(pushed).not.toHaveBeenCalled();
  leilaSocket.close();
  hamzaSocket.close();
});

it("sends a Web Push when the app isn't on screen, respects the settings, and stops at sign-out", async () => {
  await approvedUser("hamza");
  const leila = await approvedUser("leila.b");
  const hamza = await appSignIn("hamza");
  const leilaApp = await appSignIn("leila.b");
  await request(url).post("/api/notifications/push").set(leilaApp.as).send(subscription(1)).expect(200);
  expect((await request(url).get("/api/notifications").set(leilaApp.as)).body).toEqual({
    prefs: { messages: true, chats: true, contacts: true },
    pushKey: vapid.publicKey,
  });

  // App closed: pushed
  await request(url).post("/api/contacts/add").set(hamza.as).send({ personalId: leila.personalId }).expect(200);
  await pushes(1);
  const [target, payload] = pushed.mock.calls[0]!;
  expect(target.endpoint).toBe("https://push.example.com/send/1");
  expect(JSON.parse(payload as string)).toMatchObject({ title: "hamza", body: "wants to connect with you" });

  // App open in a hidden tab: pushed too; on screen: not
  const socket = await openSocket(leilaApp.token, false);
  const requestId = (await request(url).get("/api/contacts").set(leilaApp.as)).body.incoming[0].id;
  await request(url).post(`/api/contacts/requests/${requestId}/accept`).set(leilaApp.as).expect(200);
  const chatId = (await request(url).post("/api/chats").set(hamza.as).send({ userId: leila.id, mode: "keep", retentionMinutes: 60, key: key() })).body.chat.id;
  await pushes(2);
  socket.emit("visibility", { visible: true });
  await settle();
  const cancelled = next(socket, "chat_ended");
  await request(url).post(`/api/chats/${chatId}/decline`).set(hamza.as).expect(200);
  await cancelled;
  await settle();
  expect(pushed).toHaveBeenCalledTimes(2);

  // Contact notifications turned off: banner only (system: false), no push
  socket.emit("visibility", { visible: false });
  await request(url).put("/api/notifications").set(leilaApp.as).send({ chats: false }).expect(200);
  const banner = next(socket, "chat_invite");
  await request(url).post("/api/chats").set(hamza.as).send({ userId: leila.id, mode: "keep", retentionMinutes: 60, key: key() }).expect(201);
  expect((await banner).system).toBe(false);
  await settle();
  expect(pushed).toHaveBeenCalledTimes(2);
  socket.close();

  // Signing out ends the subscription
  await request(url).post("/api/auth/logout").set(leilaApp.as).expect(200);
  expect(await PushSubscription.countDocuments()).toBe(0);
});
