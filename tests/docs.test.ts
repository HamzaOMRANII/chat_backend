import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app.js";
import { hashSecret } from "../src/lib/secrets.js";
import { config, fakeMailer } from "./helpers.js";

const CODE = "4815162342";
const dir = mkdtempSync(join(tmpdir(), "h-chat-docs-"));
mkdirSync(join(dir, "uml"));
writeFileSync(join(dir, "index.html"), "<h1>Docs home</h1>");
writeFileSync(join(dir, "uml", "index.html"), "<h1>UML</h1>");
writeFileSync(join(dir, "architecture.html"), "<h1>Architecture</h1>");

let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  app = createApp({ ...config, DOCS_DIR: dir, DOCS_CODE_HASH: await hashSecret(CODE) }, fakeMailer().mailer);
});

const unlock = (agent: ReturnType<typeof request.agent>, code: string) => agent.post("/documentation/unlock").type("form").send({ code });

describe("documentation", () => {
  it("asks for the access code first and serves nothing else", async () => {
    const res = await request(app).get("/documentation/architecture");
    expect(res.status).toBe(401);
    expect(res.text).toMatch(/Enter the documentation access code/);
    expect(res.text).not.toMatch(/Architecture<\/h1>/);
  });

  it("adds the trailing slash so relative links work", async () => {
    const res = await request(app).get("/documentation");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/documentation/");
  });

  it("refuses a wrong code", async () => {
    const res = await unlock(request.agent(app), "1111111111");
    expect(res.status).toBe(401);
    expect(res.text).toMatch(/Wrong access code/);
  });

  it("opens with the right code: cookie limited to /documentation, pages served", async () => {
    const agent = request.agent(app);
    const res = await unlock(agent, CODE);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/documentation/");
    expect(res.headers["set-cookie"]![0]).toMatch(/hc_docs=.*Path=\/documentation;.*HttpOnly;.*SameSite=Strict/);
    expect((await agent.get("/documentation/")).text).toMatch(/Docs home/);
    expect((await agent.get("/documentation/architecture")).text).toMatch(/Architecture/);
    expect((await agent.get("/documentation/uml/")).text).toMatch(/UML/);
    expect((await agent.get("/documentation/nope")).status).toBe(404);
    // Signing out of the docs
    await agent.post("/documentation/lock");
    expect((await agent.get("/documentation/")).status).toBe(401);
  });

  it("never accepts a session token or a forged cookie", async () => {
    const forged = jwt.sign({ use: "docs" }, config.JWT_SECRET, { algorithm: "HS256" });
    expect((await request(app).get("/documentation/").set("Cookie", `hc_docs=${forged}`)).status).toBe(401);
  });

  it("does not leave the docs folder", async () => {
    const agent = request.agent(app);
    await unlock(agent, CODE);
    expect((await agent.get("/documentation/..%2f..%2fetc%2fpasswd")).status).toBe(404);
  });

  it("is off without a code hash", async () => {
    const off = createApp({ ...config, DOCS_DIR: dir, DOCS_CODE_HASH: undefined }, fakeMailer().mailer);
    expect((await request(off).get("/documentation/")).status).toBe(404);
  });
});
