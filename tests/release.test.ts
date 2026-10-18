import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { Category } from "../src/models/category.js";
import { Group } from "../src/models/group.js";
import { adminAgent, approvedUser, connectTestDb, makeApp, resetTestDb } from "./helpers.js";

let { app, mail } = makeApp();
beforeAll(connectTestDb);
afterAll(() => mongoose.disconnect());
beforeEach(async () => {
  await resetTestDb();
  ({ app, mail } = makeApp());
});

describe("release 1.0", () => {
  it("minimum app version: set by the administrator, public for the app", async () => {
    expect((await request(app).get("/api/app/config")).body).toEqual({ minAppVersion: "0.0.0" });
    const adm = await adminAgent(app, mail);
    expect((await adm.put("/api/admin/settings").send({ minAppVersion: "one" })).status).toBe(400);
    await adm.put("/api/admin/settings").send({ minAppVersion: "1.0.0" }).expect(200);
    expect((await request(app).get("/api/app/config")).body).toEqual({ minAppVersion: "1.0.0" });
  });

  it("settings backup and restore: categories, groups, settings (never messages)", async () => {
    const a = await approvedUser("hamza");
    const b = await approvedUser("leila.b");
    const adm = await adminAgent(app, mail);
    const friends = (await Category.findOne({ name: "Friends" }))!;
    await adm.post("/api/admin/groups").send({ name: "Site team", categoryId: friends.id, retentionMinutes: 1440, memberIds: [a.id, b.id] }).expect(201);
    await adm.put("/api/admin/settings").send({ minAppVersion: "0.9.0" }).expect(200);
    const backup = (await adm.get("/api/admin/backup")).body;
    expect(backup).toMatchObject({ app: "H_CHAT", kind: "settings-backup", settings: { minAppVersion: "0.9.0" }, groups: [{ name: "Site team", category: "Friends", members: ["hamza", "leila.b"] }] });
    expect(JSON.stringify(backup)).not.toMatch(/ciphertext|password|identity/);

    await Group.deleteMany({});
    await Category.updateOne({ name: "Friends" }, { "rules.maxRetentionDays": 1 });
    expect((await adm.post("/api/admin/restore").send({ confirm: "no", backup })).status).toBe(400);
    expect((await adm.post("/api/admin/restore").send({ confirm: "RESTORE", backup })).body).toMatchObject({ groups: 1, skipped: [] });
    expect((await Category.findOne({ name: "Friends" }))!.rules!.maxRetentionDays).toBe(7);
    expect(await Group.countDocuments({ name: "Site team" })).toBe(1);
  });

  it("activity log: filters by action and finds what an admin did", async () => {
    const adm = await adminAgent(app, mail);
    await adm.put("/api/admin/settings").send({ minAppVersion: "0.9.0" }).expect(200);
    await adm.get("/api/admin/backup").expect(200);
    const all = (await adm.get("/api/admin/logs")).body;
    expect(all.actions).toEqual(expect.arrayContaining(["settings.backup", "settings.min_version"]));
    const only = (await adm.get("/api/admin/logs?action=settings.backup")).body.logs;
    expect(only.map((l: { action: string }) => l.action)).toEqual(["settings.backup"]);
    expect((await adm.get("/api/admin/logs?action=settings.")).body.logs).toHaveLength(2);
  });

  it("limits visitors who aren't signed in to 120 requests a minute", async () => {
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await request(app).get("/api/app/config")).status;
    expect(last).toBe(429);
  });
});
