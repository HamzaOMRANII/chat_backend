import { createServer } from "node:http";
import mongoose from "mongoose";
import { loadConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { createRealtime } from "./realtime/index.js";
import { startCleanupJob } from "./jobs/cleanup.js";
import { logger } from "./lib/logger.js";
import { createMailer } from "./lib/mailer.js";
import { seedCategories } from "./models/category.js";
import { User } from "./models/user.js";
import { ensurePersonalId } from "./modules/contacts/service.js";

const config = loadConfig();

await mongoose.connect(config.MONGO_URI);
await seedCategories();
// Accounts approved before contacts existed get their personal ID
for (const user of await User.find({ role: "user", status: "approved", personalId: null })) await ensurePersonalId(user);
logger.info("connected to MongoDB");

const httpServer = createServer(createApp(config, createMailer(config)));
const io = createRealtime(httpServer, config);
const cleanup = startCleanupJob();

httpServer.listen(config.PORT, config.HOST, () => {
  logger.info(`H_CHAT backend listening on http://${config.HOST}:${config.PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  clearInterval(cleanup);
  io.close();
  httpServer.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
