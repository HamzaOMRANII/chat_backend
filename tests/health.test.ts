import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const config = loadConfig({
  NODE_ENV: "test",
  MONGO_URI: "mongodb://127.0.0.1:27017/h_chat_test",
  JWT_SECRET: "x".repeat(32),
  ADMIN_JWT_SECRET: "y".repeat(32),
  TURN_SECRET: "z".repeat(32),
  EMAIL_HOST: "smtp.example.com",
  EMAIL_PORT: "465",
  EMAIL_FROM: "test@example.com",
  EMAIL_PASSWORD: "secret",
});

describe("app", () => {
  const app = createApp(config);

  it("reports the database as down when MongoDB is not connected", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", db: "down" });
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("only allows the H_CHAT origins", async () => {
    const ok = await request(app).get("/api/nope").set("Origin", "https://chat.omranisystems.com");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://chat.omranisystems.com");
    const apk = await request(app).get("/api/nope").set("Origin", "https://localhost");
    expect(apk.headers["access-control-allow-origin"]).toBe("https://localhost");
    const bad = await request(app).get("/api/nope").set("Origin", "https://evil.example");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("config", () => {
  it("rejects short secrets", () => {
    expect(() => loadConfig({ MONGO_URI: "mongodb://x", JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("splits TURN_URLS into a list", () => {
    expect(config.TURN_URLS).toHaveLength(3);
    expect(config.TURN_URLS[0]).toBe("turn:turn.omranisystems.com:3478?transport=udp");
  });
});
