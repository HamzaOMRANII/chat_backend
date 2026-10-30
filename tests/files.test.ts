import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import type request from "supertest";
import { StoredFile } from "../src/models/file.js";
import { User } from "../src/models/user.js";
import { chunkPath, cleanupFiles, CHUNK_PLAIN } from "../src/modules/files/service.js";
import { adminAgent, approvedUser, connectTestDb, device, makeApp, resetTestDb, signIn } from "./helpers.js";

let { app, mail } = makeApp();
beforeAll(connectTestDb);
afterAll(() => mongoose.disconnect());
beforeEach(async () => {
  await resetTestDb();
  ({ app, mail } = makeApp());
});

type Agent = ReturnType<typeof request.agent>;
const b64 = (n: number) => randomBytes(n).toString("base64");
const key = () => ({ pub: b64(32), sig: b64(64) });

async function deviceUser(username: string) {
  const dev = device();
  const { agent } = await signIn(app, mail, username, dev);
  await agent
    .put("/api/keys/identity")
    .send({ deviceId: dev.deviceId, signPub: b64(32) })
    .expect(200);
  return agent;
}

async function chatBetween(categories = ["Friends"], minutes = 1440) {
  const a = await approvedUser("hamza", categories);
  const b = await approvedUser("leila.b", categories);
  const agentA = await deviceUser("hamza");
  const agentB = await deviceUser("leila.b");
  const { code } = (await agentA.post("/api/contacts/invite")).body;
  await agentB.post("/api/contacts/add").send({ inviteCode: code }).expect(200);
  const invite = await agentA.post("/api/chats").send({ userId: b.id, mode: "keep", retentionMinutes: minutes, key: key() });
  await agentB.post(`/api/chats/${invite.body.chat.id}/accept`).send({ key: key() }).expect(200);
  return { a, b, agentA, agentB, chatId: invite.body.chat.id as string };
}

/** Uploads a file of `size` plain bytes in encrypted pieces (random bytes stand in for the ciphertext). */
async function upload(agent: Agent, chatId: string, size: number) {
  const start = await agent.post(`/api/chats/${chatId}/files`).send({ kind: "document", size });
  expect(start.status).toBe(201);
  const { id, chunks } = start.body.file;
  for (let n = 0; n < chunks; n++) {
    const plain = n < chunks - 1 ? CHUNK_PLAIN : size - (chunks - 1) * CHUNK_PLAIN;
    await agent
      .put(`/api/files/${id}/chunks/${n}`)
      .set("Content-Type", "application/octet-stream")
      .send(randomBytes(plain + 40))
      .expect(200);
  }
  return id as string;
}
const message = (fileId?: string) => ({ ciphertext: b64(80), nonce: b64(24), senderKeyVersion: 1, recipientKeyVersion: 1, ...(fileId ? { fileId } : {}) });

describe("files in a stored chat", () => {
  it("upload in pieces, go with a message, download by the other side, and expire with it", async () => {
    const { agentA, agentB, chatId } = await chatBetween();
    const id = await upload(agentA, chatId, CHUNK_PLAIN + 1000);
    const sent = await agentA.post(`/api/chats/${chatId}/messages`).send(message(id));
    expect(sent.status).toBe(201);
    expect(sent.body.message.fileId).toBe(id);
    const file = (await StoredFile.findById(id))!;
    expect(file.status).toBe("ready");
    expect(file.expiresAt.getTime()).toBe(new Date(sent.body.message.expiresAt).getTime());

    const piece = await agentB
      .get(`/api/files/${id}/chunks/1`)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => cb(null, Buffer.concat(parts)));
      });
    expect(piece.status).toBe(200);
    expect((piece.body as Buffer).length).toBe(1040);
    expect((await agentB.get(`/api/chats/${chatId}/files`)).body.files).toMatchObject([{ id, status: "ready", kind: "document" }]);

    await StoredFile.updateOne({ _id: id }, { expiresAt: new Date(Date.now() - 1000) });
    await cleanupFiles();
    expect((await StoredFile.findById(id))!.status).toBe("deleted");
    expect(existsSync(chunkPath(id, 0))).toBe(false);
    expect((await agentB.get(`/api/files/${id}/chunks/0`)).status).toBe(404);
  });

  it("refuse a message whose file isn't complete, oversize files, and wrong piece sizes", async () => {
    const { agentA, chatId } = await chatBetween();
    const start = await agentA.post(`/api/chats/${chatId}/files`).send({ kind: "image", size: 5000 });
    expect((await agentA.post(`/api/chats/${chatId}/messages`).send(message(start.body.file.id))).body.code).toBe("file_incomplete");
    expect(
      (await agentA.put(`/api/files/${start.body.file.id}/chunks/0`).set("Content-Type", "application/octet-stream").send(randomBytes(10))).body.code,
    ).toBe("bad_piece");
    expect((await agentA.post(`/api/chats/${chatId}/files`).send({ kind: "video", size: 101 * 1024 * 1024 })).status).toBe(400);
  });

  it("aren't allowed where the category says no files", async () => {
    const { agentA, chatId } = await chatBetween(["Externals"]);
    expect((await agentA.post(`/api/chats/${chatId}/files`).send({ kind: "image", size: 100 })).body.code).toBe("files_not_allowed");
  });

  it("count against the sender's 2 GB", async () => {
    const { a, agentA, chatId } = await chatBetween();
    await StoredFile.create({
      chatId,
      senderId: a.id,
      recipientId: a.id,
      kind: "video",
      size: 2 * 1024 ** 3 - 50,
      chunks: 1,
      status: "ready",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect((await agentA.post(`/api/chats/${chatId}/files`).send({ kind: "image", size: 100 })).body.code).toBe("quota_full");
    expect((await agentA.get("/api/media")).body).toMatchObject({ files: 1, limit: 2 * 1024 ** 3 });
  });

  it("are deleted for both by either side, and when the chat ends", async () => {
    const { agentA, agentB, chatId } = await chatBetween();
    const one = await upload(agentA, chatId, 300);
    await agentA.post(`/api/chats/${chatId}/messages`).send(message(one)).expect(201);
    const two = await upload(agentA, chatId, 300);
    await agentA.post(`/api/chats/${chatId}/messages`).send(message(two)).expect(201);
    expect((await agentB.post("/api/files/delete").send({ ids: [one] })).body.deleted).toBe(1);
    expect((await StoredFile.findById(one))!.deletedReason).toBe("deleted_by_user");
    await agentA.delete(`/api/chats/${chatId}`).expect(200);
    expect((await StoredFile.findById(two))!.deletedReason).toBe("chat_ended");
  });
});

describe("storage in the backoffice", () => {
  it("shows sizes only, asks a user to download before a deadline, then deletes", async () => {
    const { a, agentA, chatId } = await chatBetween();
    const id = await upload(agentA, chatId, 300);
    await agentA.post(`/api/chats/${chatId}/messages`).send(message(id)).expect(201);
    const adm = await adminAgent(app, mail);

    const storage = (await adm.get("/api/admin/storage")).body;
    expect(storage).toMatchObject({ files: 1, users: [{ username: "hamza", files: 1, bytes: 340 }] });
    expect(storage.disk.limit).toBe(0.8);
    expect((await adm.get(`/api/admin/storage/users/${a.id}`)).body.files).toMatchObject([{ id, kind: "document", size: 340, to: "leila.b" }]);

    await adm.post(`/api/admin/storage/users/${a.id}/request`).send({ hours: 72 }).expect(200);
    expect((await agentA.get("/api/media")).body.request).toBeTruthy();
    await User.updateOne({ _id: a.id }, { "mediaRequest.deadline": new Date(Date.now() - 1000) });
    await cleanupFiles();
    expect((await StoredFile.findById(id))!.deletedReason).toBe("removed_by_admin");
    expect((await agentA.get("/api/media")).body.request).toBeNull();
  });

  it("deletes a user's files at once", async () => {
    const { a, agentA, chatId } = await chatBetween();
    const id = await upload(agentA, chatId, 300);
    await agentA.post(`/api/chats/${chatId}/messages`).send(message(id)).expect(201);
    const adm = await adminAgent(app, mail);
    expect((await adm.post("/api/admin/storage/delete").send({ userId: a.id })).body).toMatchObject({ deleted: 1, bytes: 340 });
    expect((await StoredFile.findById(id))!.deletedReason).toBe("removed_by_admin");
  });
});
