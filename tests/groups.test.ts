import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Category } from "../src/models/category.js";
import { Group, GroupMessage } from "../src/models/group.js";
import { adminAgent, approvedUser, connectTestDb, device, makeApp, resetTestDb, signIn } from "./helpers.js";

let { app, mail } = makeApp();
beforeAll(connectTestDb);
afterAll(() => mongoose.disconnect());
beforeEach(async () => {
  await resetTestDb();
  ({ app, mail } = makeApp());
});

const b64 = (n: number) => randomBytes(n).toString("base64");
const key = () => ({ pub: b64(32), sig: b64(64) });

async function member(name: string) {
  const user = await approvedUser(name);
  const dev = device();
  const { agent } = await signIn(app, mail, name, dev);
  await agent.put("/api/keys/identity").send({ deviceId: dev.deviceId, signPub: b64(32) }).expect(200);
  return { id: user.id as string, agent };
}
const friends = async () => (await Category.findOne({ name: "Friends" }))!.id as string;
const message = (wraps: { userId: string; keyVersion: number }[]) => ({ ciphertext: b64(80), nonce: b64(24), senderKeyVersion: 1, wraps: wraps.map((w) => ({ ...w, key: b64(72) })) });

describe("groups", () => {
  it("are made by the administrator; messages are locked for each member; someone removed gets nothing new", async () => {
    const a = await member("hamza");
    const b = await member("leila.b");
    const c = await member("rami.t");
    const adm = await adminAgent(app, mail);
    const made = await adm.post("/api/admin/groups").send({ name: "Site team", categoryId: await friends(), retentionMinutes: 4320, memberIds: [a.id, b.id, c.id] });
    expect(made.status).toBe(201);
    const gid = made.body.group.id;
    for (const m of [a, b, c]) await m.agent.post(`/api/groups/${gid}/keys`).send({ key: key() }).expect(200);
    expect((await a.agent.get("/api/groups")).body.groups[0]).toMatchObject({ name: "Site team", members: expect.any(Array), files: true });

    // A message for a non-member is refused; for the three of them it goes through
    const stranger = await member("eve");
    expect((await a.agent.post(`/api/groups/${gid}/messages`).send(message([{ userId: a.id, keyVersion: 1 }, { userId: stranger.id, keyVersion: 1 }]))).body.code).toBe("stale_members");
    await a.agent.post(`/api/groups/${gid}/messages`).send(message([a, b, c].map((m) => ({ userId: m.id, keyVersion: 1 })))).expect(201);
    const forC = (await c.agent.get(`/api/groups/${gid}/messages`)).body.messages.filter((m: { senderId: string | null }) => m.senderId);
    expect(forC[0].wrap).toBeTruthy();
    expect(forC[0].ciphertext).toBeTruthy();

    // rami.t removed: his key is gone, messages can't be locked for him, he can't read the group anymore
    await adm.put(`/api/admin/groups/${gid}`).send({ memberIds: [a.id, b.id] }).expect(200);
    expect((await Group.findById(gid))!.keys.some((k) => String(k.userId) === c.id)).toBe(false);
    expect((await a.agent.post(`/api/groups/${gid}/messages`).send(message([a, b, c].map((m) => ({ userId: m.id, keyVersion: 1 }))))).body.code).toBe("stale_members");
    await a.agent.post(`/api/groups/${gid}/messages`).send(message([a, b].map((m) => ({ userId: m.id, keyVersion: 1 })))).expect(201);
    expect((await c.agent.get(`/api/groups/${gid}/messages`)).status).toBe(404);
    expect(await GroupMessage.countDocuments({ "wraps.userId": new mongoose.Types.ObjectId(c.id), senderId: { $exists: true } })).toBe(1); // only the one sent before
    const system = (await b.agent.get(`/api/groups/${gid}/messages`)).body.messages.filter((m: { system: unknown }) => m.system).map((m: { system: { kind: string } }) => m.system.kind);
    expect(system).toContain("removed");
  });

  it("have at most 10 people and respect the category's durations", async () => {
    const adm = await adminAgent(app, mail);
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push((await approvedUser(`user${i}`)).id);
    expect((await adm.post("/api/admin/groups").send({ name: "Too big", categoryId: await friends(), retentionMinutes: 1440, memberIds: ids })).body.code).toBe("too_many_members");
    const externals = (await Category.findOne({ name: "Externals" }))!.id;
    expect((await adm.post("/api/admin/groups").send({ name: "Long", categoryId: externals, retentionMinutes: 10080, memberIds: ids.slice(0, 3) })).body.code).toBe("mode_not_allowed");
  });

  it("can be asked by a user with their contacts, and start once the administrator approves", async () => {
    const a = await member("hamza");
    const b = await member("leila.b");
    const { code } = (await a.agent.post("/api/contacts/invite")).body;
    await b.agent.post("/api/contacts/add").send({ inviteCode: code }).expect(200);
    const stranger = await approvedUser("eve");
    expect((await a.agent.post("/api/groups/requests").send({ name: "Weekend", memberIds: [stranger.id] })).body.code).toBe("not_contact");
    const asked = await a.agent.post("/api/groups/requests").send({ name: "Weekend", memberIds: [b.id] });
    expect(asked.status).toBe(201);
    expect((await a.agent.get("/api/groups")).body).toMatchObject({ groups: [], requests: [{ name: "Weekend", status: "pending" }] });
    expect((await b.agent.get("/api/groups")).body.groups).toHaveLength(0);

    const adm = await adminAgent(app, mail);
    expect((await adm.get("/api/admin/groups")).body.pending).toBe(1);
    await adm.put(`/api/admin/groups/${asked.body.request.id}`).send({ categoryId: await friends(), retentionMinutes: 1440 }).expect(200);
    expect((await b.agent.get("/api/groups")).body.groups[0]).toMatchObject({ name: "Weekend" });

    const second = (await a.agent.post("/api/groups/requests").send({ name: "Nope", memberIds: [b.id] })).body.request.id;
    await adm.post(`/api/admin/groups/${second}/refuse`).expect(200);
    expect((await a.agent.get("/api/groups")).body.requests).toMatchObject([{ name: "Nope", status: "refused" }]);
  });

  it("members can leave", async () => {
    const a = await member("hamza");
    const b = await member("leila.b");
    const adm = await adminAgent(app, mail);
    const gid = (await adm.post("/api/admin/groups").send({ name: "Duo", categoryId: await friends(), retentionMinutes: 1440, memberIds: [a.id, b.id] })).body.group.id;
    await b.agent.post(`/api/groups/${gid}/leave`).expect(200);
    expect((await Group.findById(gid))!.members.map(String)).toEqual([a.id]);
  });
});
