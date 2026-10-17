import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { io as connect } from "socket.io-client";
import { createApp } from "../src/app.js";
import { createRealtime } from "../src/realtime/index.js";
import { approvedUser, config, connectTestDb, device, fakeMailer, PASSWORD, resetTestDb } from "./helpers.js";
import request from "supertest";

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

async function appSignIn(name: string, username = "hamza") {
  const step1 = await request(url).post("/api/auth/login").set("X-Client", "android").send({ username, password: PASSWORD, device: device({ name, platform: "android" }) });
  const step2 = await request(url).post("/api/auth/verify-code").set("X-Client", "android").send({ challengeId: step1.body.challengeId, code: mail.lastCode() });
  return step2.body.token as string;
}

it("tells the old device it was replaced, then disconnects it", async () => {
  await approvedUser("hamza");
  const firstToken = await appSignIn("Old phone");
  const socket = connect(url, { path: "/socket.io", auth: { token: firstToken }, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });

  const revoked = new Promise<{ reason: string; by: { name: string } }>((resolve) => socket.on("session:revoked", resolve));
  const disconnected = new Promise<void>((resolve) => socket.on("disconnect", () => resolve()));
  await appSignIn("New phone");

  expect(await revoked).toMatchObject({ reason: "new_login", by: { name: "New phone" } });
  await disconnected;
  socket.close();
});

it("refuses a socket without a valid session", async () => {
  const socket = connect(url, { path: "/socket.io", auth: { token: "nope" }, transports: ["websocket"] });
  const error = await new Promise<Error>((resolve) => socket.on("connect_error", resolve));
  expect(error.message).toBe("unauthorized");
  socket.close();
});

function openSocket(token: string) {
  const socket = connect(url, { path: "/socket.io", auth: { token }, transports: ["websocket"] });
  return new Promise<typeof socket>((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

it("tells the other side about a request, and shows contacts online while the app is open", async () => {
  await approvedUser("hamza");
  const leila = await approvedUser("leila.b");
  const hamzaToken = await appSignIn("Phone", "hamza");
  const leilaToken = await appSignIn("Laptop", "leila.b");
  const leilaSocket = await openSocket(leilaToken);

  const changed = new Promise<void>((resolve) => leilaSocket.once("contacts:changed", () => resolve()));
  const api = (path: string) => request(url).post(path).set("Authorization", `Bearer ${hamzaToken}`);
  await api("/api/contacts/add").send({ personalId: leila.personalId }).expect(200);
  await changed;

  const requestId = (await request(url).get("/api/contacts").set("Authorization", `Bearer ${leilaToken}`)).body.incoming[0].id;
  await request(url).post(`/api/contacts/requests/${requestId}/accept`).set("Authorization", `Bearer ${leilaToken}`).expect(200);

  const cameOnline = new Promise<void>((resolve) => leilaSocket.once("contacts:changed", () => resolve()));
  const hamzaSocket = await openSocket(hamzaToken);
  await cameOnline;
  const list = await request(url).get("/api/contacts").set("Authorization", `Bearer ${leilaToken}`);
  expect(list.body.contacts[0]).toMatchObject({ username: "hamza", online: true });

  const wentOffline = new Promise<void>((resolve) => leilaSocket.once("contacts:changed", () => resolve()));
  hamzaSocket.close();
  await wentOffline;
  const after = await request(url).get("/api/contacts").set("Authorization", `Bearer ${leilaToken}`);
  expect(after.body.contacts[0]).toMatchObject({ online: false, lastSeenAt: expect.any(String) });
  leilaSocket.close();
});

it("delivers new messages, typing and chat end live", async () => {
  await approvedUser("hamza");
  const leila = await approvedUser("leila.b");
  const hamzaToken = await appSignIn("Phone", "hamza");
  const leilaToken = await appSignIn("Laptop", "leila.b");
  const as = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Client": "android" });
  const b64 = (n: number) => Buffer.alloc(n, 7).toString("base64");
  const key = () => ({ pub: b64(32), sig: b64(64) });
  // identity keys (device ids come from appSignIn's device())
  const me = async (token: string) => (await request(url).get("/api/me/security-log").set(as(token))).body.current.deviceId as string;
  for (const token of [hamzaToken, leilaToken]) await request(url).put("/api/keys/identity").set(as(token)).send({ deviceId: await me(token), signPub: b64(32) }).expect(200);
  const { code } = (await request(url).post("/api/contacts/invite").set(as(hamzaToken))).body;
  await request(url).post("/api/contacts/add").set(as(leilaToken)).send({ inviteCode: code }).expect(200);
  const chatId = (await request(url).post("/api/chats").set(as(hamzaToken)).send({ userId: leila.id, mode: "keep", retentionMinutes: 1440, key: key() })).body.chat.id;
  await request(url).post(`/api/chats/${chatId}/accept`).set(as(leilaToken)).send({ key: key() }).expect(200);

  const leilaSocket = await openSocket(leilaToken);
  const hamzaSocket = await openSocket(hamzaToken);

  const arrived = new Promise<{ chatId: string; message: { ciphertext: string } }>((resolve) => leilaSocket.once("msg:new", resolve));
  await request(url).post(`/api/chats/${chatId}/messages`).set(as(hamzaToken)).send({ ciphertext: b64(40), nonce: b64(24), senderKeyVersion: 1, recipientKeyVersion: 1 }).expect(201);
  expect((await arrived).chatId).toBe(chatId);

  const read = new Promise<{ read: string[] }>((resolve) => hamzaSocket.once("msg:status", resolve));
  await request(url).post(`/api/chats/${chatId}/receipts`).set(as(leilaToken)).send({ read: true }).expect(200);
  expect((await read).read).toHaveLength(1);

  const typing = new Promise<{ chatId: string }>((resolve) => leilaSocket.once("typing", resolve));
  hamzaSocket.emit("typing", { chatId });
  expect((await typing).chatId).toBe(chatId);

  const ended = new Promise<{ reason: string }>((resolve) => hamzaSocket.once("chat:ended", resolve));
  await request(url).delete(`/api/chats/${chatId}`).set(as(leilaToken)).expect(200);
  expect((await ended).reason).toBe("ended_by_user");
  leilaSocket.close();
  hamzaSocket.close();
});

it("accepts the web app's session cookie on the socket (the cookie covers /socket.io)", async () => {
  await approvedUser("hamza");
  const agent = request.agent(url);
  const step1 = await agent.post("/api/auth/login").send({ username: "hamza", password: PASSWORD, device: device() });
  const step2 = await agent.post("/api/auth/verify-code").send({ challengeId: step1.body.challengeId, code: mail.lastCode() });
  const cookie = (step2.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("hc_session=") && !c.startsWith("hc_session=;"))!;
  expect(cookie).toMatch(/Path=\/;/);
  const socket = connect(url, { path: "/socket.io", transports: ["websocket"], extraHeaders: { cookie: cookie.split(";")[0]! } });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });
  socket.close();
});

it("web app: a 60-second ticket opens the live connection, whatever cookies the browser sends; the API refuses it", async () => {
  await approvedUser("hamza");
  const agent = request.agent(url);
  const step1 = await agent.post("/api/auth/login").send({ username: "hamza", password: PASSWORD, device: device() });
  await agent.post("/api/auth/verify-code").send({ challengeId: step1.body.challengeId, code: mail.lastCode() }).expect(200);
  const { ticket } = (await agent.get("/api/auth/socket-ticket").expect(200)).body;

  // No cookie at all on the socket (like a browser holding an old /api-only cookie): the ticket is enough
  const socket = connect(url, { path: "/socket.io", auth: { ticket }, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });
  socket.close();

  expect((await request(url).get("/api/auth/me").set("Authorization", `Bearer ${ticket}`)).status).toBe(401);
  expect((await request(url).get("/api/auth/socket-ticket")).status).toBe(401);
});
