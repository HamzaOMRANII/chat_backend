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
