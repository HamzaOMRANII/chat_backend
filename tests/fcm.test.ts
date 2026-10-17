import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { FcmToken } from "../src/models/fcmToken.js";
import { configureFcm, sendFcm } from "../src/modules/notify/fcm.js";
import { approvedUser, connectTestDb, makeApp, resetTestDb, signIn } from "./helpers.js";

let { app, mail } = makeApp();
beforeAll(connectTestDb);
afterAll(() => mongoose.disconnect());
beforeEach(async () => {
  await resetTestDb();
  ({ app, mail } = makeApp());
});
afterEach(() => vi.unstubAllGlobals());

it("a phone's Firebase token belongs to its session: signing out deletes it", async () => {
  await approvedUser("hamza");
  const { agent } = await signIn(app, mail, "hamza");
  await agent.post("/api/notifications/fcm").send({ token: "t".repeat(160) }).expect(200);
  expect(await FcmToken.countDocuments()).toBe(1);
  await agent.post("/api/auth/logout").expect(200);
  expect(await FcmToken.countDocuments()).toBe(0);
});

it("Google only gets a generic text: never who wrote, never the content", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const file = `${process.env.TMPDIR ?? "/tmp"}/hchat-test-fcm.json`;
  writeFileSync(file, JSON.stringify({ project_id: "test-project", client_email: "x@test.iam.gserviceaccount.com", private_key: privateKey }));
  expect(await configureFcm(file)).toBe(true);
  const user = await approvedUser("hamza");
  const sessionId = new mongoose.Types.ObjectId();
  await FcmToken.create({ userId: user.id, sessionId, token: "phone-token" });
  const sent: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body) });
      return url.includes("oauth2") ? new Response(JSON.stringify({ access_token: "a", expires_in: 3600 })) : new Response("{}");
    }),
  );
  await sendFcm(String(sessionId), { kind: "message", tag: "chat:1", url: "/#chat=1", body: "leila.b: secret plans" });
  await sendFcm(String(sessionId), { kind: "call", tag: "call:1", url: "/#contact=1", body: "Incoming video call" });
  const messages = sent.filter((s) => s.url.includes("fcm.googleapis.com")).map((s) => JSON.parse(s.body).message);
  expect(messages[0].android.notification).toMatchObject({ title: "H_CHAT", body: "New message", channel_id: "hc_events" });
  expect(messages[1].android).toMatchObject({ ttl: "45s", notification: { body: "Incoming call", channel_id: "hc_calls" } });
  expect(JSON.stringify(messages)).not.toMatch(/leila|secret/);
  await configureFcm(undefined);
});
