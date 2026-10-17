import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { ExportRequest } from "../src/models/exportRequest.js";
import { expireExports } from "../src/modules/exports/routes.js";
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

async function chatBetween(categories = ["Friends"]) {
  await approvedUser("hamza", categories);
  const b = await approvedUser("leila.b", categories);
  const agents = [];
  for (const name of ["hamza", "leila.b"]) {
    const dev = device();
    const { agent } = await signIn(app, mail, name, dev);
    await agent.put("/api/keys/identity").send({ deviceId: dev.deviceId, signPub: b64(32) }).expect(200);
    agents.push(agent);
  }
  const [agentA, agentB] = agents as [(typeof agents)[0], (typeof agents)[0]];
  const { code } = (await agentA.post("/api/contacts/invite")).body;
  await agentB.post("/api/contacts/add").send({ inviteCode: code }).expect(200);
  const invite = await agentA.post("/api/chats").send({ userId: b.id, mode: "keep", retentionMinutes: 1440, key: key() });
  await agentB.post(`/api/chats/${invite.body.chat.id}/accept`).send({ key: key() }).expect(200);
  const chatId = invite.body.chat.id as string;
  for (let i = 0; i < 3; i++) await agentA.post(`/api/chats/${chatId}/messages`).send({ ciphertext: b64(80), nonce: b64(24), senderKeyVersion: 1, recipientKeyVersion: 1 }).expect(201);
  return { agentA, agentB, chatId };
}

describe("exports", () => {
  it("need the other side's approval, then open a 24-hour window", async () => {
    const { agentA, agentB, chatId } = await chatBetween();
    const asked = await agentA.post(`/api/chats/${chatId}/exports`).send({ messages: true, media: true, period: "all" });
    expect(asked.status).toBe(201);
    expect(asked.body.export).toMatchObject({ status: "pending", counts: { messages: 3, files: 0 } });
    const id = asked.body.export.id;
    expect((await agentA.post(`/api/chats/${chatId}/exports`).send({ messages: true, media: false, period: "all" })).body.code).toBe("export_pending");

    expect((await agentA.post(`/api/exports/${id}/approve`)).status).toBe(403); // not the requester's to approve
    expect((await agentA.post(`/api/exports/${id}/downloaded`)).body.code).toBe("export_closed");
    const approved = await agentB.post(`/api/exports/${id}/approve`);
    expect(approved.body.export.status).toBe("approved");
    const hours = (Date.parse(approved.body.export.until) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(23.9);
    await agentA.post(`/api/exports/${id}/downloaded`).expect(200);
    expect((await agentB.get(`/api/chats/${chatId}/exports`)).body.exports[0].downloadedAt).toBeTruthy();

    // The window closes after 24 hours
    await ExportRequest.updateOne({ _id: id }, { until: new Date(Date.now() - 1000) });
    await expireExports();
    expect((await agentA.post(`/api/exports/${id}/downloaded`)).body.code).toBe("export_closed");

    const adm = await adminAgent(app, mail);
    expect((await adm.get(`/api/admin/chats/${chatId}`)).body.exports).toMatchObject([{ by: "hamza", approver: "leila.b", status: "approved" }]);
  });

  it("can be refused, expire unanswered, and aren't possible where the rules forbid export", async () => {
    const { agentA, agentB, chatId } = await chatBetween();
    const one = (await agentA.post(`/api/chats/${chatId}/exports`).send({ messages: true, media: false, period: "24h" })).body.export.id;
    expect((await agentB.post(`/api/exports/${one}/refuse`)).body.export.status).toBe("refused");
    const two = (await agentB.post(`/api/chats/${chatId}/exports`).send({ messages: true, media: true, period: "7d" })).body.export.id;
    await ExportRequest.updateOne({ _id: two }, { until: new Date(Date.now() - 1000) });
    await expireExports();
    expect((await ExportRequest.findById(two))!.status).toBe("expired");
    expect((await agentA.post(`/api/exports/${two}/approve`)).body.code).toBe("not_pending");
  });

  it("aren't allowed where the category forbids export", async () => {
    const { agentA, chatId } = await chatBetween(["Confidential"]);
    expect((await agentA.post(`/api/chats/${chatId}/exports`).send({ messages: true, media: true, period: "all" })).body.code).toBe("export_not_allowed");
  });
});
