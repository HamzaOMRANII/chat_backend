import mongoose from "mongoose";
import request from "supertest";
import { newPersonalId } from "../src/modules/contacts/service.js";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Mailer } from "../src/lib/mailer.js";
import { hashSecret } from "../src/lib/secrets.js";
import { Category, seedCategories } from "../src/models/category.js";
import { User } from "../src/models/user.js";

// Local test database (user h_chat_test, readWrite on h_chat_test only); override with TEST_MONGO_URI.
export const TEST_MONGO_URI = process.env.TEST_MONGO_URI ?? "mongodb://h_chat_test:h_chat_test_local_only@127.0.0.1:27017/h_chat_test?authSource=h_chat_test";

export const config = loadConfig({
  NODE_ENV: "test",
  MONGO_URI: TEST_MONGO_URI,
  JWT_SECRET: "x".repeat(32),
  ADMIN_JWT_SECRET: "y".repeat(32),
  TURN_SECRET: "z".repeat(32),
  EMAIL_HOST: "smtp.example.com",
  EMAIL_PORT: "465",
  EMAIL_FROM: "test@example.com",
  EMAIL_PASSWORD: "secret",
  // Never the real media folder
  MEDIA_DIR: `${process.env.TMPDIR ?? "/tmp"}/h-chat-test-media`,
});

/** Captures the codes the server would email. */
export function fakeMailer() {
  const sent: { to: string; code: string; purpose: string }[] = [];
  const alerts: { to: string; username: string; where: string }[] = [];
  const mailer: Mailer = {
    async sendCode({ to, code, purpose }) {
      sent.push({ to, code, purpose });
    },
    async sendSecureCodeAlert({ to, username, where }) {
      alerts.push({ to, username, where });
    },
  };
  return { mailer, sent, alerts, lastCode: () => sent.at(-1)!.code };
}

export async function connectTestDb() {
  if (mongoose.connection.readyState !== 1) await mongoose.connect(TEST_MONGO_URI);
}

export async function resetTestDb() {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  await seedCategories();
}

let deviceCounter = 0;
export const device = (extra: Record<string, unknown> = {}) => ({
  deviceId: `test-device-${String(++deviceCounter).padStart(8, "0")}`,
  platform: "web",
  ...extra,
});

export const PASSWORD = "correct horse battery";
export const PASSCODE = "12345678";

export async function signUp(app: Express, username: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/auth/signup")
    .send({ username, email: `${username}@example.com`, password: PASSWORD, passcode: PASSCODE, privacyAccepted: true, device: device(), ...extra });
}

/** Creates an approved user straight in the database (with a personal ID). */
export async function approvedUser(username: string, categoryNames = ["Friends"]) {
  const categories = await Category.find({ name: { $in: categoryNames } });
  return User.create({
    username,
    email: `${username}@example.com`,
    passwordHash: await hashSecret(PASSWORD),
    passcodeHash: await hashSecret(PASSCODE),
    status: "approved",
    categoryIds: categories.map((c) => c._id),
    privacyAcceptedAt: new Date(),
    personalId: newPersonalId(),
  });
}

/** Full two-step sign-in; returns the agent (keeps the cookie) and the response. */
export async function signIn(app: Express, mail: ReturnType<typeof fakeMailer>, username: string, dev = device()) {
  const agent = request.agent(app);
  const step1 = await agent.post("/api/auth/login").send({ username, password: PASSWORD, device: dev });
  if (step1.status !== 200) throw new Error(`login failed: ${step1.status} ${JSON.stringify(step1.body)}`);
  const step2 = await agent.post("/api/auth/verify-code").send({ challengeId: step1.body.challengeId, code: mail.lastCode() });
  return { agent, res: step2 };
}

export async function adminAgent(app: Express, mail: ReturnType<typeof fakeMailer>) {
  await User.create({
    username: "boss",
    email: "boss@example.com",
    role: "admin",
    status: "approved",
    passwordHash: await hashSecret(PASSWORD),
    passcodeHash: await hashSecret("00000000"),
  });
  const agent = request.agent(app);
  const step1 = await agent.post("/api/admin/auth/login").send({ username: "boss", password: PASSWORD, device: device() });
  await agent.post("/api/admin/auth/verify-code").send({ challengeId: step1.body.challengeId, code: mail.lastCode() }).expect(200);
  return agent;
}

export function makeApp() {
  const mail = fakeMailer();
  return { app: createApp(config, mail.mailer), mail };
}
