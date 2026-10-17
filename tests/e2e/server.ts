/**
 * Local end-to-end server: the real API + Socket.IO on the TEST database, a fake mailer whose codes can be
 * read at /__codes, and the built chat app (../chat_app/dist) on the same origin. For browser tests only.
 *   npx tsx tests/e2e/server.ts [port]
 */
import { createServer } from "node:http";
import { join } from "node:path";
import express from "express";
import mongoose from "mongoose";
import { createApp } from "../../src/app.js";
import { seedCategories } from "../../src/models/category.js";
import { createRealtime } from "../../src/realtime/index.js";
import { approvedUser, config, fakeMailer, TEST_MONGO_URI } from "../helpers.js";

const port = Number(process.argv[2] ?? 4790);
await mongoose.connect(TEST_MONGO_URI);
await mongoose.connection.db!.dropDatabase();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
await seedCategories();

const mail = fakeMailer();
const outer = express();
// Same Content-Security-Policy as nginx sends in production (socket on this origin instead of wss://chat…)
outer.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:${port}; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  );
  next();
});
outer.get("/__codes", (_req, res) => res.json(mail.sent));
// Exactly what the database holds for messages, to check that no plaintext reaches the server
outer.get("/__files", async (_req, res) => res.json(await mongoose.connection.db!.collection("files").find({ status: "ready" }).toArray()));
// Every piece on disk, and whether it contains a PNG header in clear (it never should)
outer.get("/__media", async (_req, res) => {
  const { readdir, readFile } = await import("node:fs/promises");
  const out: { piece: string; includesPlain: boolean }[] = [];
  for (const dir of await readdir(config.MEDIA_DIR).catch(() => [] as string[]))
    for (const n of await readdir(`${config.MEDIA_DIR}/${dir}`).catch(() => [] as string[])) {
      const data = await readFile(`${config.MEDIA_DIR}/${dir}/${n}`);
      out.push({ piece: `${dir}/${n}`, includesPlain: data.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])) });
    }
  res.json(out);
});
outer.get("/__messages", async (_req, res) => res.json(await mongoose.connection.db!.collection("messages").find().toArray()));
// Two approved contacts-to-be in Friends (password "correct horse battery")
outer.post("/__seed", async (_req, res) => {
  await approvedUser("hamza");
  await approvedUser("leila.b");
  res.json({ ok: true });
});
outer.use(express.static(join(import.meta.dirname, "../../../chat_app/dist")));
outer.use(createApp({ ...config, APP_ORIGIN: `http://127.0.0.1:${port}` }, mail.mailer));
const server = createServer(outer);
createRealtime(server, { ...config, APP_ORIGIN: `http://127.0.0.1:${port}` });
server.listen(port, "127.0.0.1", () => console.log(`e2e server on http://127.0.0.1:${port}`));
