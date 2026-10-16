import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Category } from "../src/models/category.js";
import { Friendship } from "../src/models/friendship.js";
import { User } from "../src/models/user.js";
import { normalizePersonalId } from "../src/modules/contacts/service.js";
import { adminAgent, approvedUser, connectTestDb, makeApp, resetTestDb, signIn } from "./helpers.js";

let { app, mail } = makeApp();

beforeAll(connectTestDb);
afterAll(() => mongoose.disconnect());
beforeEach(async () => {
  await resetTestDb();
  ({ app, mail } = makeApp());
});

async function twoUsers(categoriesA = ["Friends"], categoriesB = ["Friends"]) {
  const a = await approvedUser("hamza", categoriesA);
  const b = await approvedUser("leila.b", categoriesB);
  const agentA = (await signIn(app, mail, "hamza")).agent;
  const agentB = (await signIn(app, mail, "leila.b")).agent;
  return { a, b, agentA, agentB };
}

describe("personal ID", () => {
  it("reads loosely typed IDs", () => {
    expect(normalizePersonalId("hc-4kx7 92qm")).toBe("HC-4KX7-92QM");
    expect(normalizePersonalId("4KX792QM")).toBe("HC-4KX7-92QM");
    expect(normalizePersonalId("HC-4KX7-92Q0")).toBeNull(); // 0 is never used
  });

  it("is given at approval and can be changed; the old one stops working", async () => {
    const { a, agentA, agentB } = await twoUsers();
    const me = await agentA.get("/api/contacts/me");
    expect(me.body.personalId).toBe(a.personalId);
    expect(me.body.searchesLeft).toBe(10);

    const changed = await agentA.post("/api/contacts/me/new-id");
    expect(changed.body.personalId).not.toBe(a.personalId);
    expect((await agentB.post("/api/contacts/add").send({ personalId: a.personalId })).status).toBe(404);
    expect((await agentB.post("/api/contacts/add").send({ personalId: changed.body.personalId })).body.status).toBe("requested");
  });
});

describe("requests by ID", () => {
  it("sends a request; the other side accepts; both see each other", async () => {
    const { a, b, agentA, agentB } = await twoUsers();
    const sent = await agentA.post("/api/contacts/add").send({ personalId: b.personalId!.toLowerCase() });
    expect(sent.body).toMatchObject({ status: "requested", username: "leila.b", searchesLeft: 9 });

    expect((await agentA.get("/api/contacts")).body.outgoing).toHaveLength(1);
    const incoming = (await agentB.get("/api/contacts")).body.incoming;
    expect(incoming).toEqual([expect.objectContaining({ username: "hamza" })]);

    expect((await agentA.post(`/api/contacts/requests/${incoming[0].id}/accept`)).status).toBe(409); // not the sender
    expect((await agentB.post(`/api/contacts/requests/${incoming[0].id}/accept`)).status).toBe(200);
    const listA = (await agentA.get("/api/contacts")).body;
    expect(listA.contacts).toEqual([expect.objectContaining({ id: b.id, username: "leila.b", via: "id", online: false })]);
    expect(listA.outgoing).toHaveLength(0);
    expect((await agentB.get(`/api/contacts/${a.id}`)).body.contact.username).toBe("hamza");
  });

  it("asking back is accepting", async () => {
    const { a, b, agentA, agentB } = await twoUsers();
    await agentA.post("/api/contacts/add").send({ personalId: b.personalId });
    const res = await agentB.post("/api/contacts/add").send({ personalId: a.personalId });
    expect(res.body.status).toBe("contact");
  });

  it("declining or cancelling deletes the request", async () => {
    const { b, agentA, agentB } = await twoUsers();
    await agentA.post("/api/contacts/add").send({ personalId: b.personalId });
    const id = (await agentB.get("/api/contacts")).body.incoming[0].id;
    expect((await agentB.post(`/api/contacts/requests/${id}/decline`)).status).toBe(200);
    expect((await agentA.get("/api/contacts")).body.outgoing).toHaveLength(0);
    expect(await Friendship.countDocuments()).toBe(0);
  });

  it("answers the same 'not found' for a wrong ID, another category, yourself and a blocker", async () => {
    const { a, b, agentA, agentB } = await twoUsers(["Friends"], ["Pro"]);
    const answers = [
      await agentA.post("/api/contacts/add").send({ personalId: "HC-2222-2222" }),
      await agentA.post("/api/contacts/add").send({ personalId: b.personalId }), // no shared category
      await agentA.post("/api/contacts/add").send({ personalId: a.personalId }), // myself
    ];
    await User.updateOne({ _id: b._id }, { categoryIds: a.categoryIds });
    await agentB.post(`/api/contacts/${a.id}/block`);
    answers.push(await agentA.post("/api/contacts/add").send({ personalId: b.personalId })); // blocked
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("No one found with this ID. Check it with the person.");
    }
    expect(answers.at(-1)!.body.details.searchesLeft).toBe(6);
  });

  it("allows 10 searches an hour", async () => {
    const { agentA } = await twoUsers();
    for (let i = 0; i < 10; i++) await agentA.post("/api/contacts/add").send({ personalId: "HC-2222-2222" });
    const res = await agentA.post("/api/contacts/add").send({ personalId: "HC-2222-2222" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("too_many_searches");
  });
});

describe("invite codes", () => {
  it("connects at once, works once, and a new code replaces the old", async () => {
    const { a, agentA, agentB } = await twoUsers();
    const first = (await agentA.post("/api/contacts/invite")).body.code;
    const invite = (await agentA.post("/api/contacts/invite")).body;
    expect(invite.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect((await agentA.get("/api/contacts/me")).body.invite.code).toBe(invite.code);
    expect((await agentB.post("/api/contacts/add").send({ inviteCode: first })).status).toBe(404);

    const res = await agentB.post("/api/contacts/add").send({ inviteCode: invite.code.toLowerCase().replace("-", " ") });
    expect(res.body).toMatchObject({ status: "contact", contact: { id: a.id, username: "hamza", via: "invite" } });
    expect((await agentA.get("/api/contacts/me")).body.invite).toBeNull();
    expect((await agentA.get("/api/contacts")).body.contacts).toHaveLength(1);
  });

  it("stays valid when someone who can't use it tries", async () => {
    const { agentA, agentB } = await twoUsers(["Friends"], ["Pro"]);
    const { code } = (await agentA.post("/api/contacts/invite")).body;
    expect((await agentB.post("/api/contacts/add").send({ inviteCode: code })).body.error).toMatch(/No one found with this code/);
    expect((await agentA.post("/api/contacts/add").send({ inviteCode: code })).status).toBe(404); // own code
    expect((await agentA.get("/api/contacts/me")).body.invite.code).toBe(code);
  });

  it("can be cancelled", async () => {
    const { agentA, agentB } = await twoUsers();
    const { code } = (await agentA.post("/api/contacts/invite")).body;
    await agentA.delete("/api/contacts/invite");
    expect((await agentB.post("/api/contacts/add").send({ inviteCode: code })).status).toBe(404);
  });
});

describe("remove, block, pause", () => {
  async function connected() {
    const users = await twoUsers();
    const { code } = (await users.agentA.post("/api/contacts/invite")).body;
    await users.agentB.post("/api/contacts/add").send({ inviteCode: code });
    return users;
  }

  it("removes a contact for both sides", async () => {
    const { b, agentA, agentB } = await connected();
    expect((await agentA.delete(`/api/contacts/${b.id}`)).status).toBe(200);
    expect((await agentB.get("/api/contacts")).body.contacts).toHaveLength(0);
  });

  it("blocking ends the contact and stops new codes from the blocked person", async () => {
    const { b, agentA, agentB } = await connected();
    await agentA.post(`/api/contacts/${b.id}/block`);
    expect((await agentA.get("/api/contacts")).body.contacts).toHaveLength(0);
    const { code } = (await agentB.post("/api/contacts/invite")).body;
    expect((await agentA.post("/api/contacts/add").send({ inviteCode: code })).status).toBe(404);
  });

  it("pauses a contact when the pair no longer shares a category, and restores it after", async () => {
    const { a, b, agentA, agentB } = await connected();
    const admin = await adminAgent(app, mail);
    const pro = await Category.findOne({ name: "Pro" });
    const friends = await Category.findOne({ name: "Friends" });
    await admin.put(`/api/admin/users/${b.id}/categories`).send({ categoryIds: [pro!.id] }).expect(200);
    expect((await agentA.get("/api/contacts")).body.contacts).toHaveLength(0);
    expect((await agentB.get(`/api/contacts/${a.id}`)).status).toBe(404);

    const view = (await admin.get(`/api/admin/users/${a.id}/contacts`)).body;
    expect(view.personalId).toBe(a.personalId);
    expect(view.contacts).toEqual([expect.objectContaining({ paused: true, categoryId: null, via: "invite" })]);

    await admin.put(`/api/admin/users/${b.id}/categories`).send({ categoryIds: [pro!.id, friends!.id] }).expect(200);
    expect((await agentA.get("/api/contacts")).body.contacts).toHaveLength(1);
  });
});

describe("backoffice", () => {
  it("picks which shared category applies, and can end a contact", async () => {
    const { a, b, agentA, agentB } = await twoUsers(["Friends", "Pro"], ["Pro", "Friends"]);
    const { code } = (await agentA.post("/api/contacts/invite")).body;
    await agentB.post("/api/contacts/add").send({ inviteCode: code });
    const admin = await adminAgent(app, mail);
    const friends = await Category.findOne({ name: "Friends" });
    const pro = await Category.findOne({ name: "Pro" });
    const secret = await Category.findOne({ name: "Secret" });

    let row = (await admin.get(`/api/admin/users/${a.id}/contacts`)).body.contacts[0];
    expect(row.categoryId).toBe(friends!.id); // Friends comes before Pro in the order
    expect(row.categoryChosen).toBe(false);

    expect((await admin.put(`/api/admin/friendships/${row.id}/category`).send({ categoryId: secret!.id })).status).toBe(400);
    await admin.put(`/api/admin/friendships/${row.id}/category`).send({ categoryId: pro!.id }).expect(200);
    row = (await admin.get(`/api/admin/users/${b.id}/contacts`)).body.contacts[0];
    expect(row).toMatchObject({ categoryId: pro!.id, categoryChosen: true, user: { username: "hamza" } });

    await admin.delete(`/api/admin/friendships/${row.id}`).expect(200);
    expect((await agentA.get("/api/contacts")).body.contacts).toHaveLength(0);
  });

  it("gives a personal ID on approval and removes contacts with a deleted account", async () => {
    const admin = await adminAgent(app, mail);
    const pending = await User.create({ username: "rami.t", email: "rami@example.com", passwordHash: "x", passcodeHash: "x" });
    const friends = await Category.findOne({ name: "Friends" });
    await admin.post(`/api/admin/users/${pending.id}/approve`).send({ categoryIds: [friends!.id] }).expect(200);
    expect((await User.findById(pending.id))!.personalId).toMatch(/^HC-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

    const { b, agentA } = await twoUsers();
    await agentA.post("/api/contacts/add").send({ personalId: b.personalId });
    await admin.delete(`/api/admin/users/${b.id}`).send({ confirm: "leila.b" }).expect(200);
    expect(await Friendship.countDocuments()).toBe(0);
  });
});
