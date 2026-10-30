import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { DeviceEvent } from "../src/models/deviceEvent.js";
import { User } from "../src/models/user.js";
import { approvedUser, connectTestDb, device, makeApp, PASSCODE, PASSWORD, resetTestDb, signIn, signUp } from "./helpers.js";

let { app, mail } = makeApp();

beforeAll(connectTestDb);
afterAll(() => mongoose.disconnect());
beforeEach(async () => {
  await resetTestDb();
  ({ app, mail } = makeApp());
});

describe("sign-up", () => {
  it("creates a pending account and records the sign-up device", async () => {
    const res = await signUp(app, "leila.b");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "pending", username: "leila.b" });
    const user = await User.findOne({ username: "leila.b" });
    expect(user?.status).toBe("pending");
    expect(await DeviceEvent.countDocuments({ userId: user!._id, type: "signup" })).toBe(1);
  });

  it("refuses a short passcode, a short password and a missing privacy acceptance", async () => {
    expect((await signUp(app, "a1b", { passcode: "1234" })).body.error).toMatch(/8 digits/);
    expect((await signUp(app, "a1c", { password: "short" })).body.error).toMatch(/12 characters/);
    expect((await signUp(app, "a1d", { privacyAccepted: false })).body.error).toMatch(/privacy/);
  });

  it("refuses a taken username or email", async () => {
    await signUp(app, "leila.b");
    expect((await signUp(app, "leila.b", { email: "other@example.com" })).status).toBe(409);
  });

  it("tells a pending user they wait for approval only after a correct password", async () => {
    await signUp(app, "leila.b");
    const wrong = await request(app).post("/api/auth/login").send({ username: "leila.b", password: "not the password!", device: device() });
    expect(wrong.status).toBe(401);
    const right = await request(app).post("/api/auth/login").send({ username: "leila.b", password: PASSWORD, device: device() });
    expect(right.status).toBe(403);
    expect(right.body.code).toBe("pending");
  });
});

describe("sign-in", () => {
  it("needs the emailed code, then opens a session", async () => {
    await approvedUser("hamza");
    const step1 = await request(app).post("/api/auth/login").send({ username: "hamza", password: PASSWORD, device: device() });
    expect(step1.status).toBe(200);
    expect(step1.body.emailHint).toBe("h•••a@example.com");
    expect(mail.sent.at(-1)).toMatchObject({ to: "hamza@example.com", purpose: "login" });

    const agent = request.agent(app);
    const bad = await agent
      .post("/api/auth/verify-code")
      .send({ challengeId: step1.body.challengeId, code: "000000" === mail.lastCode() ? "111111" : "000000" });
    expect(bad.status).toBe(400);
    expect(bad.body.details.attemptsLeft).toBe(4);

    const ok = await agent.post("/api/auth/verify-code").send({ challengeId: step1.body.challengeId, code: mail.lastCode() });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeUndefined(); // web: httpOnly cookie, never in the body
    expect(ok.headers["set-cookie"]?.[0]).toMatch(/hc_session=.*HttpOnly.*SameSite=Strict/i);
    const me = await agent.get("/api/auth/me");
    expect(me.body.user.username).toBe("hamza");
  });

  it("accepts the account email instead of the username", async () => {
    await approvedUser("hamza");
    const res = await request(app).post("/api/auth/login").send({ username: " Hamza@Example.com ", password: PASSWORD, device: device() });
    expect(res.status).toBe(200);
    expect(mail.sent.at(-1)).toMatchObject({ to: "hamza@example.com", purpose: "login" });
    const bad = await request(app).post("/api/auth/login").send({ username: "not valid!", password: PASSWORD, device: device() });
    expect(bad.body.error).toMatch(/username or email/);
  });

  it("gives the Android app a token in the body and accepts it as Bearer", async () => {
    await approvedUser("hamza");
    const step1 = await request(app)
      .post("/api/auth/login")
      .set("X-Client", "android")
      .send({ username: "hamza", password: PASSWORD, device: device({ platform: "android", model: "SM-S911B", manufacturer: "samsung" }) });
    const ok = await request(app).post("/api/auth/verify-code").set("X-Client", "android").send({ challengeId: step1.body.challengeId, code: mail.lastCode() });
    expect(ok.body.token).toEqual(expect.any(String));
    expect(ok.headers["set-cookie"]).toBeUndefined();
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${ok.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.session.device.name).toBe("samsung SM-S911B");
  });

  it("locks sign-in for 30 minutes after 5 wrong passwords", async () => {
    await approvedUser("hamza");
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/login").send({ username: "hamza", password: "wrong password here", device: device() });
    }
    const res = await request(app).post("/api/auth/login").send({ username: "hamza", password: PASSWORD, device: device() });
    expect(res.status).toBe(423);
    const user = await User.findOne({ username: "hamza" });
    expect(user!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
  });
});

describe("one device at a time", () => {
  it("closes the first session when the account signs in elsewhere, and says where", async () => {
    await approvedUser("hamza");
    const first = await signIn(app, mail, "hamza", device());
    await signIn(app, mail, "hamza", device({ name: "Galaxy S23", platform: "android" }));

    const res = await first.agent.get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("session_revoked");
    expect(res.body.details.by.name).toBe("Galaxy S23");

    const types = (await DeviceEvent.find({}).sort({ at: 1 }).lean()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["login", "kicked", "login"]));
  });

  it("shows the previous sign-in after signing in", async () => {
    await approvedUser("hamza");
    await signIn(app, mail, "hamza", device({ name: "Old laptop" }));
    const { res } = await signIn(app, mail, "hamza", device());
    expect(res.body.lastLogin.deviceName).toBe("Old laptop");
  });
});

describe("recovery passcode", () => {
  async function passcodeSignIn(passcode: string) {
    const step1 = await request(app).post("/api/auth/login").send({ username: "hamza", password: PASSWORD, device: device() });
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/verify-passcode").send({ challengeId: step1.body.challengeId, passcode });
    return { agent, res };
  }

  it("opens a reset-only session that must set a new password and a different passcode", async () => {
    await approvedUser("hamza");
    const { agent, res } = await passcodeSignIn(PASSCODE);
    expect(res.status).toBe(200);
    expect(res.body.user.mustReset).toBe(true);

    expect((await agent.get("/api/me/security-log")).status).toBe(401); // reset sessions can't use the app
    const same = await agent.post("/api/auth/reset-credentials").send({ password: "a brand new passphrase", passcode: PASSCODE });
    expect(same.body.code).toBe("same_passcode");

    const ok = await agent.post("/api/auth/reset-credentials").send({ password: "a brand new passphrase", passcode: "87654321" });
    expect(ok.status).toBe(200);
    expect(ok.body.user.mustReset).toBe(false);
    expect((await agent.get("/api/me/security-log")).status).toBe(200);
    const user = await User.findOne({ username: "hamza" });
    expect(user!.mustReset).toBe(false);
  });

  it("refuses a wrong passcode and counts it", async () => {
    await approvedUser("hamza");
    const { res } = await passcodeSignIn("99999999");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("wrong_passcode");
    expect((await User.findOne({ username: "hamza" }))!.failedAttempts).toBe(1);
  });

  it("keeps forcing the reset on the next email sign-in until it's done", async () => {
    await approvedUser("hamza");
    await passcodeSignIn(PASSCODE);
    const { agent, res } = await signIn(app, mail, "hamza");
    expect(res.body.user.mustReset).toBe(true);
    expect((await agent.get("/api/me/security-log")).status).toBe(401);
  });
});

describe("security log and logout", () => {
  it("lists the user's own events and ends the session on logout", async () => {
    await approvedUser("hamza");
    const { agent } = await signIn(app, mail, "hamza", device({ name: "My laptop" }));
    const log = await agent.get("/api/me/security-log");
    expect(log.body.events[0]).toMatchObject({ type: "login", deviceName: "My laptop" });
    await agent.post("/api/auth/logout").expect(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("changes the email only after the code sent to the new address", async () => {
    await approvedUser("hamza");
    const { agent } = await signIn(app, mail, "hamza");
    const start = await agent.post("/api/me/email").send({ email: "new@example.com" });
    expect(mail.sent.at(-1)).toMatchObject({ to: "new@example.com", purpose: "email-change" });
    expect((await User.findOne({ username: "hamza" }))!.email).toBe("hamza@example.com");
    await agent.post("/api/me/email/verify").send({ challengeId: start.body.challengeId, code: mail.lastCode() }).expect(200);
    expect((await User.findOne({ username: "hamza" }))!.email).toBe("new@example.com");
  });
});
