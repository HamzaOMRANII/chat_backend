import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { DeviceEvent } from "../src/models/deviceEvent.js";
import { User } from "../src/models/user.js";
import { adminAgent, approvedUser, connectTestDb, device, makeApp, PASSCODE, PASSWORD, resetTestDb, signIn } from "./helpers.js";

let { app, mail } = makeApp();

beforeAll(connectTestDb);
afterAll(() => mongoose.disconnect());
beforeEach(async () => {
  await resetTestDb();
  ({ app, mail } = makeApp());
});

const SECURE = "55667788";

async function setSecureCode(username: string, code = SECURE) {
  const { agent } = await signIn(app, mail, username);
  return agent.put("/api/me/secure-code").send({ password: PASSWORD, secureCode: code });
}

async function passwordStep(username: string) {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username, password: PASSWORD, device: device({ name: "Pixel 8" }) });
  expect(res.status).toBe(200);
  return res.body.challengeId as string;
}

describe("secure code in Settings", () => {
  it("is off until set, needs the password, and can't equal the recovery passcode", async () => {
    await approvedUser("hamza");
    const { agent } = await signIn(app, mail, "hamza");
    expect((await agent.get("/api/me/secure-code")).body).toMatchObject({ set: false, allowed: true });
    expect((await agent.put("/api/me/secure-code").send({ password: "wrong password!!", secureCode: SECURE })).status).toBe(401);
    expect((await agent.put("/api/me/secure-code").send({ password: PASSWORD, secureCode: "123" })).body.error).toMatch(/8 to 12 digits/);
    expect((await agent.put("/api/me/secure-code").send({ password: PASSWORD, secureCode: PASSCODE })).body.code).toBe("same_as_passcode");
    const ok = await agent.put("/api/me/secure-code").send({ password: PASSWORD, secureCode: SECURE });
    expect(ok.body).toMatchObject({ set: true, allowed: true });
    expect((await agent.get("/api/me/secure-code")).body.set).toBe(true);
    // Never sent back, even hashed
    expect(JSON.stringify((await agent.get("/api/auth/me")).body)).not.toMatch(/secureCodeHash/);
  });

  it("can be removed with the password", async () => {
    await approvedUser("hamza");
    const { agent } = await signIn(app, mail, "hamza");
    await agent.put("/api/me/secure-code").send({ password: PASSWORD, secureCode: SECURE });
    expect((await agent.delete("/api/me/secure-code").send({ password: PASSWORD })).body.set).toBe(false);
    const challengeId = await passwordStep("hamza");
    expect((await request(app).post("/api/auth/verify-secure-code").send({ challengeId, secureCode: SECURE })).body.code).toBe("wrong_secure_code");
  });
});

describe("signing in with the secure code", () => {
  it("replaces the emailed code after the password, logs it and emails an alert", async () => {
    const user = await approvedUser("hamza");
    await setSecureCode("hamza");
    const challengeId = await passwordStep("hamza");
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/verify-secure-code").send({ challengeId, secureCode: SECURE });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("hamza");
    expect((await agent.get("/api/auth/me")).status).toBe(200);
    expect(await DeviceEvent.countDocuments({ userId: user._id, type: "secure_code_used" })).toBe(1);
    expect(mail.alerts).toEqual([{ to: "hamza@example.com", username: "hamza", where: expect.stringContaining("Pixel 8") }]);
    // The challenge is used up
    expect((await request(app).post("/api/auth/verify-secure-code").send({ challengeId, secureCode: SECURE })).body.code).toBe("challenge_expired");
  });

  it("never works without the password step", async () => {
    await approvedUser("hamza");
    await setSecureCode("hamza");
    const res = await request(app).post("/api/auth/verify-secure-code").send({ challengeId: new mongoose.Types.ObjectId().toString(), secureCode: SECURE });
    expect(res.body.code).toBe("challenge_expired");
  });

  it("counts wrong codes toward the lock and answers the same when no code is set", async () => {
    const user = await approvedUser("hamza");
    await approvedUser("leila");
    await setSecureCode("hamza");
    const leilaChallenge = await passwordStep("leila");
    expect((await request(app).post("/api/auth/verify-secure-code").send({ challengeId: leilaChallenge, secureCode: SECURE })).body.code).toBe(
      "wrong_secure_code",
    );

    const challengeId = await passwordStep("hamza");
    const wrong = await request(app).post("/api/auth/verify-secure-code").send({ challengeId, secureCode: "99999999" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.details.attemptsLeft).toBe(4);
    expect(await DeviceEvent.countDocuments({ userId: user._id, type: "failed_secure_code" })).toBe(1);
    expect((await User.findById(user._id))!.failedAttempts).toBe(1);
  });

  it("is refused once the administrator switches it off", async () => {
    const user = await approvedUser("hamza");
    await setSecureCode("hamza");
    await User.updateOne({ _id: user._id }, { secureCodeDisabled: true });
    const challengeId = await passwordStep("hamza");
    expect((await request(app).post("/api/auth/verify-secure-code").send({ challengeId, secureCode: SECURE })).body.code).toBe("wrong_secure_code");
    const { agent } = await signIn(app, mail, "hamza");
    expect((await agent.get("/api/me/secure-code")).body.allowed).toBe(false);
    expect((await agent.put("/api/me/secure-code").send({ password: PASSWORD, secureCode: "11223344" })).body.code).toBe("secure_code_disabled");
  });

  it("is cleared by a recovery-passcode reset", async () => {
    const user = await approvedUser("hamza");
    await setSecureCode("hamza");
    const challengeId = await passwordStep("hamza");
    const agent = request.agent(app);
    await agent.post("/api/auth/verify-passcode").send({ challengeId, passcode: PASSCODE });
    expect((await agent.post("/api/auth/reset-credentials").send({ password: "a brand new password", passcode: "87654321" })).status).toBe(200);
    expect((await User.findById(user._id).select("+secureCodeHash"))!.secureCodeHash).toBeUndefined();
  });
});

describe("backoffice switch", () => {
  it("lets the administrator switch the secure code off and on, and logs it", async () => {
    const user = await approvedUser("hamza");
    const admin = await adminAgent(app, mail);
    expect((await admin.put(`/api/admin/users/${user.id}/secure-code`).send({ allowed: false })).body).toEqual({ allowed: false });
    expect((await User.findById(user._id))!.secureCodeDisabled).toBe(true);
    const details = await admin.get(`/api/admin/users/${user.id}`);
    expect(details.body.user.secureCodeDisabled).toBe(true);
    expect(details.body.user.secureCodeHash).toBeUndefined();
    await admin.put(`/api/admin/users/${user.id}/secure-code`).send({ allowed: true });
    expect((await User.findById(user._id))!.secureCodeDisabled).toBe(false);
  });
});
