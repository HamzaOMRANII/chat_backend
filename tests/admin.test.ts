import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { AdminLog } from "../src/models/adminLog.js";
import { Category } from "../src/models/category.js";
import { User } from "../src/models/user.js";
import { adminAgent, approvedUser, connectTestDb, device, makeApp, PASSWORD, resetTestDb, signIn, signUp } from "./helpers.js";

let { app, mail } = makeApp();

beforeAll(connectTestDb);
afterAll(() => mongoose.disconnect());
beforeEach(async () => {
  await resetTestDb();
  ({ app, mail } = makeApp());
});

describe("backoffice access", () => {
  it("is closed without an admin session, and a user session doesn't open it", async () => {
    expect((await request(app).get("/api/admin/users")).status).toBe(401);
    await approvedUser("hamza");
    const { agent } = await signIn(app, mail, "hamza");
    expect((await agent.get("/api/admin/users")).status).toBe(401);
  });

  it("refuses admins in the chat app", async () => {
    await adminAgent(app, mail);
    const res = await request(app).post("/api/auth/login").send({ username: "boss", password: PASSWORD, device: device() });
    expect(res.status).toBe(401);
  });
});

describe("approving accounts", () => {
  it("approves a pending request with categories, after which the user can sign in", async () => {
    const admin = await adminAgent(app, mail);
    await signUp(app, "leila.b");
    const list = await admin.get("/api/admin/users?status=pending");
    expect(list.body.counts.pending).toBe(1);
    const [pending] = list.body.users;
    expect(pending.lastDevice.type).toBe("signup");

    const noCategory = await admin.post(`/api/admin/users/${pending.id}/approve`).send({ categoryIds: [] });
    expect(noCategory.status).toBe(400);

    const pro = await Category.findOne({ name: "Pro" });
    await admin.post(`/api/admin/users/${pending.id}/approve`).send({ categoryIds: [pro!.id] }).expect(200);
    const { res } = await signIn(app, mail, "leila.b");
    expect(res.status).toBe(200);
    expect(await AdminLog.countDocuments({ action: "user.approved" })).toBe(1);
  });

  it("rejects a request; the user learns it when signing in", async () => {
    const admin = await adminAgent(app, mail);
    await signUp(app, "spam.bot");
    const user = await User.findOne({ username: "spam.bot" });
    await admin.post(`/api/admin/users/${user!.id}/reject`).expect(200);
    const login = await request(app).post("/api/auth/login").send({ username: "spam.bot", password: PASSWORD, device: device() });
    expect(login.body.code).toBe("rejected");
  });
});

describe("managing accounts", () => {
  it("suspending ends the user's session immediately", async () => {
    const admin = await adminAgent(app, mail);
    const user = await approvedUser("hamza");
    const { agent } = await signIn(app, mail, "hamza");
    await admin.post(`/api/admin/users/${user.id}/suspend`).expect(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    const login = await request(app).post("/api/auth/login").send({ username: "hamza", password: PASSWORD, device: device() });
    expect(login.body.code).toBe("suspended");
    await admin.post(`/api/admin/users/${user.id}/reactivate`).expect(200);
    expect((await signIn(app, mail, "hamza")).res.status).toBe(200);
  });

  it("shows devices and the login history in the user details", async () => {
    const admin = await adminAgent(app, mail);
    const user = await approvedUser("hamza");
    await signIn(app, mail, "hamza", device({ deviceId: "laptop-0000000000001", name: "Laptop" }));
    await signIn(app, mail, "hamza", device({ deviceId: "phone-00000000000001", name: "Phone", platform: "android" }));
    const details = await admin.get(`/api/admin/users/${user.id}`);
    expect(details.body.devices.map((d: { name: string }) => d.name)).toEqual(["Phone", "Laptop"]);
    expect(details.body.currentDeviceId).toBe("phone-00000000000001");
    expect(details.body.events.some((e: { type: string }) => e.type === "kicked")).toBe(true);
  });

  it("deletes an account only when the username is typed to confirm", async () => {
    const admin = await adminAgent(app, mail);
    const user = await approvedUser("hamza");
    expect((await admin.delete(`/api/admin/users/${user.id}`).send({ confirm: "hamz" })).status).toBe(400);
    await admin.delete(`/api/admin/users/${user.id}`).send({ confirm: "hamza" }).expect(200);
    expect(await User.exists({ username: "hamza" })).toBeNull();
  });

  it("hands out a one-time reset code for someone who lost email and passcode", async () => {
    const admin = await adminAgent(app, mail);
    const user = await approvedUser("hamza");
    const { body } = await admin.post(`/api/admin/users/${user.id}/reset-access`).expect(200);
    expect(body.code).toMatch(/^\d{10}$/);

    const agent = request.agent(app);
    const res = await agent.post("/api/auth/admin-reset").send({ username: "hamza", code: body.code, device: device() });
    expect(res.body.user.mustReset).toBe(true);
    await agent.post("/api/auth/reset-credentials").send({ password: "a brand new passphrase", passcode: "11223344" }).expect(200);
    // The code works once
    expect((await request(app).post("/api/auth/admin-reset").send({ username: "hamza", code: body.code, device: device() })).status).toBe(401);
  });
});

describe("categories", () => {
  it("starts with the six default categories in order", async () => {
    const admin = await adminAgent(app, mail);
    const { body } = await admin.get("/api/admin/categories");
    expect(body.categories.map((c: { name: string }) => c.name)).toEqual(["Family", "Friends", "Pro", "Externals", "Secret", "Confidential"]);
    expect(body.categories.find((c: { name: string }) => c.name === "Secret").rules.modes).toEqual(["live"]);
  });

  it("edits rules, refuses an empty mode list, and won't delete a category in use", async () => {
    const admin = await adminAgent(app, mail);
    const secret = await Category.findOne({ name: "Secret" });
    const rules = { modes: [], maxRetentionDays: 0, files: "p2p", export: false, calls: "voice" };
    expect((await admin.patch(`/api/admin/categories/${secret!.id}`).send({ rules })).status).toBe(400);
    await admin.patch(`/api/admin/categories/${secret!.id}`).send({ rules: { ...rules, modes: ["live"] } }).expect(200);
    expect((await Category.findById(secret!.id))!.rules!.calls).toBe("voice");

    await approvedUser("hamza", ["Secret"]);
    expect((await admin.delete(`/api/admin/categories/${secret!.id}`)).body.code).toBe("category_in_use");
  });
});
