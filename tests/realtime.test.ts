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

async function appSignIn(name: string) {
  const step1 = await request(url).post("/api/auth/login").set("X-Client", "android").send({ username: "hamza", password: PASSWORD, device: device({ name, platform: "android" }) });
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
