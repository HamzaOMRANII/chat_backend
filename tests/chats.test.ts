import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import type { Express } from "express";
import type request from "supertest";
import { Category } from "../src/models/category.js";
import { Chat } from "../src/models/chat.js";
import { Message } from "../src/models/message.js";
import { expireChats } from "../src/modules/chats/service.js";
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
const encrypted = (versions = { senderKeyVersion: 1, recipientKeyVersion: 1 }) => ({ ciphertext: b64(80), nonce: b64(24), ...versions });

type Agent = ReturnType<typeof request.agent>;

/** Signs in with a known device id and publishes that device's identity key. */
async function deviceUser(theApp: Express, username: string) {
  const dev = device();
  const { agent } = await signIn(theApp, mail, username, dev);
  await agent.put("/api/keys/identity").send({ deviceId: dev.deviceId, signPub: b64(32) }).expect(200);
  return agent;
}

/** Two contacts (shared categories), both signed in with identity keys. */
async function contacts(categoriesA = ["Friends"], categoriesB = ["Friends"]) {
  const a = await approvedUser("hamza", categoriesA);
  const b = await approvedUser("leila.b", categoriesB);
  const agentA = await deviceUser(app, "hamza");
  const agentB = await deviceUser(app, "leila.b");
  const { code } = (await agentA.post("/api/contacts/invite")).body;
  await agentB.post("/api/contacts/add").send({ inviteCode: code }).expect(200);
  return { a, b, agentA, agentB };
}

async function activeChat(agentA: Agent, agentB: Agent, bId: string, mode = "keep", retentionDays = 3) {
  const invite = await agentA.post("/api/chats").send({ userId: bId, mode, retentionDays, key: key() });
  expect(invite.status).toBe(201);
  const accepted = await agentB.post(`/api/chats/${invite.body.chat.id}/accept`).send({ key: key() });
  expect(accepted.status).toBe(200);
  return invite.body.chat.id as string;
}

describe("chat options", () => {
  it("follow the rules of the category the pair uses", async () => {
    const { b, agentA } = await contacts();
    expect((await agentA.get(`/api/chats/options/${b.id}`)).body.options).toEqual({ keepMaxDays: 7, auto: true, live: true });
  });

  it("Externals: keep-alive up to 3 days only; Secret: no stored chat at all", async () => {
    const { b, agentA } = await contacts(["Externals"], ["Externals"]);
    expect((await agentA.get(`/api/chats/options/${b.id}`)).body.options).toEqual({ keepMaxDays: 3, auto: false, live: false });
    expect((await agentA.post("/api/chats").send({ userId: b.id, mode: "keep", retentionDays: 4, key: key() })).body.code).toBe("mode_not_allowed");
    expect((await agentA.post("/api/chats").send({ userId: b.id, mode: "auto", retentionDays: 7, key: key() })).body.code).toBe("mode_not_allowed");

    await Category.updateOne({ name: "Externals" }, { "rules.modes": ["live"], "rules.maxRetentionDays": 0 });
    expect((await agentA.get(`/api/chats/options/${b.id}`)).body.options).toEqual({ keepMaxDays: 0, auto: false, live: true });
  });

  it("needs a contact", async () => {
    await approvedUser("hamza");
    const stranger = await approvedUser("rami.t");
    const agent = await deviceUser(app, "hamza");
    expect((await agent.get(`/api/chats/options/${stranger.id}`)).status).toBe(404);
    expect((await agent.post("/api/chats").send({ userId: stranger.id, mode: "keep", retentionDays: 1, key: key() })).status).toBe(404);
  });
});

describe("invitation", () => {
  it("is seen by the other side, accepted, and becomes an active chat with both keys", async () => {
    const { a, b, agentA, agentB } = await contacts();
    const invite = await agentA.post("/api/chats").send({ userId: b.id, mode: "keep", retentionDays: 3, key: key() });
    expect(invite.body.chat).toMatchObject({ status: "invited", mode: "keep", retentionDays: 3, createdByMe: true, with: { username: "leila.b" } });

    const seen = (await agentB.get("/api/chats")).body.chats;
    expect(seen).toEqual([expect.objectContaining({ status: "invited", createdByMe: false, with: expect.objectContaining({ id: a.id }) })]);
    expect((await agentA.post(`/api/chats/${invite.body.chat.id}/accept`).send({ key: key() })).status).toBe(409); // not the inviter

    const accepted = await agentB.post(`/api/chats/${invite.body.chat.id}/accept`).send({ key: key() });
    expect(accepted.body.chat.status).toBe("active");
    expect(accepted.body.chat.keys.map((k: { userId: string; version: number }) => [k.userId, k.version])).toEqual([
      [a.id, 1],
      [b.id, 1],
    ]);
  });

  it("allows one open chat per pair", async () => {
    const { b, agentA, agentB } = await contacts();
    await activeChat(agentA, agentB, b.id);
    const again = await agentA.post("/api/chats").send({ userId: b.id, mode: "auto", retentionDays: 7, key: key() });
    expect(again.body.code).toBe("chat_exists");
  });

  it("needs this device's identity key first", async () => {
    const b = await approvedUser("leila.b");
    await approvedUser("hamza");
    const { agent } = await signIn(app, mail, "hamza");
    const { agent: agentB } = await signIn(app, mail, "leila.b");
    const { code } = (await agent.post("/api/contacts/invite")).body;
    await agentB.post("/api/contacts/add").send({ inviteCode: code });
    expect((await agent.post("/api/chats").send({ userId: b.id, mode: "keep", retentionDays: 1, key: key() })).body.code).toBe("no_identity");
    expect((await agent.put("/api/keys/identity").send({ deviceId: "someone-elses-device", signPub: b64(32) })).status).toBe(403);
  });

  it("declining deletes it; unanswered ones expire after 24 h", async () => {
    const { b, agentA, agentB } = await contacts();
    const first = (await agentA.post("/api/chats").send({ userId: b.id, mode: "keep", retentionDays: 2, key: key() })).body.chat.id;
    await agentB.post(`/api/chats/${first}/decline`).expect(200);
    expect((await agentA.get("/api/chats")).body.chats).toHaveLength(0);
    expect((await Chat.findById(first))!.endReason).toBe("declined");

    const second = (await agentA.post("/api/chats").send({ userId: b.id, mode: "keep", retentionDays: 2, key: key() })).body.chat.id;
    await Chat.updateOne({ _id: second }, { inviteExpiresAt: new Date(Date.now() - 1000) });
    await expireChats();
    expect((await Chat.findById(second))!.endReason).toBe("invite_expired");
  });
});

describe("messages", () => {
  it("stores only ciphertext, expires with the chat's retention, and tracks delivered / read", async () => {
    const { a, b, agentA, agentB } = await contacts();
    const chatId = await activeChat(agentA, agentB, b.id, "keep", 3);

    const sent = await agentA.post(`/api/chats/${chatId}/messages`).send(encrypted());
    expect(sent.status).toBe(201);
    const stored = await Message.findById(sent.body.message.id);
    expect(stored!.expiresAt.getTime() - stored!.sentAt.getTime()).toBe(3 * 24 * 3600_000);
    expect(Object.keys(stored!.toObject())).not.toContain("text");

    expect((await agentB.get("/api/chats")).body.chats[0].unread).toBe(1);
    const list = await agentB.get(`/api/chats/${chatId}/messages`);
    expect(list.body.messages).toEqual([expect.objectContaining({ senderId: a.id, senderKeyVersion: 1, readAt: null })]);

    expect((await agentB.post(`/api/chats/${chatId}/receipts`).send({ read: false })).body).toEqual({ delivered: 1, read: 0 });
    expect((await agentB.post(`/api/chats/${chatId}/receipts`).send({ read: true })).body).toEqual({ delivered: 0, read: 1 });
    const after = (await agentA.get(`/api/chats/${chatId}/messages`)).body.messages[0];
    expect(after.deliveredAt).not.toBeNull();
    expect(after.readAt).not.toBeNull();
    expect((await agentB.get("/api/chats")).body.chats[0].unread).toBe(0);
  });

  it("refuses unknown key versions; a new device adds a new key version", async () => {
    const { b, agentA, agentB } = await contacts();
    const chatId = await activeChat(agentA, agentB, b.id);
    expect((await agentA.post(`/api/chats/${chatId}/messages`).send(encrypted({ senderKeyVersion: 2, recipientKeyVersion: 1 }))).body.code).toBe("stale_keys");

    // leila.b signs in on a new device: new identity, then a new chat key
    const newDevice = await deviceUser(app, "leila.b");
    expect((await newDevice.post(`/api/chats/${chatId}/keys`).send({ key: key() })).body.version).toBe(2);
    expect((await agentA.post(`/api/chats/${chatId}/messages`).send(encrypted({ senderKeyVersion: 1, recipientKeyVersion: 2 }))).status).toBe(201);
  });

  it("refuses oversized and malformed messages", async () => {
    const { b, agentA, agentB } = await contacts();
    const chatId = await activeChat(agentA, agentB, b.id);
    expect((await agentA.post(`/api/chats/${chatId}/messages`).send({ ...encrypted(), ciphertext: "A".repeat(24_004) })).status).toBe(400);
    expect((await agentA.post(`/api/chats/${chatId}/messages`).send({ ...encrypted(), nonce: "short" })).status).toBe(400);
  });
});

describe("ending", () => {
  it("End chat deletes every message for both at once", async () => {
    const { b, agentA, agentB } = await contacts();
    const chatId = await activeChat(agentA, agentB, b.id);
    await agentA.post(`/api/chats/${chatId}/messages`).send(encrypted());
    await agentB.delete(`/api/chats/${chatId}`).expect(200);
    expect(await Message.countDocuments()).toBe(0);
    expect((await agentA.get(`/api/chats/${chatId}/messages`)).status).toBe(404);
    const chat = await Chat.findById(chatId);
    expect(chat).toMatchObject({ status: "ended", endReason: "ended_by_user" });
    expect(chat!.keys).toHaveLength(0);
  });

  it("ends when the contact is removed", async () => {
    const { a, b, agentA, agentB } = await contacts();
    const chatId = await activeChat(agentA, agentB, b.id);
    await agentB.delete(`/api/contacts/${a.id}`).expect(200);
    expect((await Chat.findById(chatId))!.endReason).toBe("contact_unavailable");
  });

  it("ends when tighter category rules no longer allow it", async () => {
    const { b, agentA, agentB } = await contacts();
    const chatId = await activeChat(agentA, agentB, b.id, "keep", 5);
    const admin = await adminAgent(app, mail);
    const friends = await Category.findOne({ name: "Friends" });
    await admin.patch(`/api/admin/categories/${friends!.id}`).send({ rules: { ...friends!.toObject().rules, maxRetentionDays: 3 } }).expect(200);
    expect((await Chat.findById(chatId))!.endReason).toBe("rules_changed");
  });
});

describe("backoffice", () => {
  it("shows metadata only and can delete a chat's history with a typed confirmation", async () => {
    const { b, agentA, agentB } = await contacts();
    const chatId = await activeChat(agentA, agentB, b.id, "auto", 7);
    await agentA.post(`/api/chats/${chatId}/messages`).send(encrypted());
    const admin = await adminAgent(app, mail);

    const dash = (await admin.get("/api/admin/dashboard")).body;
    expect(dash.chats).toEqual({ active: 1, keep: 0, auto: 1, invited: 0 });
    expect(dash.messages.last24h).toBe(1);
    expect(dash.users.approved).toBe(2);

    const list = (await admin.get("/api/admin/chats")).body;
    expect(list.chats[0]).toMatchObject({ label: "hamza + leila.b", mode: "auto", category: "Friends", stored: { count: 1 } });
    const details = await admin.get(`/api/admin/chats/${chatId}`);
    expect(details.body.messages[0]).toMatchObject({ from: "hamza", to: "leila.b" });
    expect(JSON.stringify(details.body)).not.toContain("ciphertext");

    expect((await admin.delete(`/api/admin/chats/${chatId}`).send({ confirm: "hamza" })).status).toBe(400);
    expect((await admin.delete(`/api/admin/chats/${chatId}`).send({ confirm: "hamza + leila.b" })).body).toEqual({ ok: true, deleted: 1 });
    expect((await Chat.findById(chatId))!.endReason).toBe("deleted_by_admin");
    expect((await admin.get("/api/admin/chats?status=ended")).body.chats).toHaveLength(1);
  });

  it("deletes all of a user's chat history", async () => {
    const { a, b, agentA, agentB } = await contacts();
    const chatId = await activeChat(agentA, agentB, b.id);
    await agentB.post(`/api/chats/${chatId}/messages`).send(encrypted());
    const admin = await adminAgent(app, mail);
    expect((await admin.delete(`/api/admin/users/${a.id}/chats`).send({ confirm: "hamza" })).body).toEqual({ ok: true, chats: 1, deleted: 1 });
    expect(await Message.countDocuments()).toBe(0);
  });
});
