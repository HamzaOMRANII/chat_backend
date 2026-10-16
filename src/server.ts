import { createServer } from "node:http";
import mongoose from "mongoose";
import { loadConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { createRealtime } from "./realtime/index.js";
import { logger } from "./lib/logger.js";

const config = loadConfig();

await mongoose.connect(config.MONGO_URI);
logger.info("connected to MongoDB");

const httpServer = createServer(createApp(config));
const io = createRealtime(httpServer, config);

httpServer.listen(config.PORT, config.HOST, () => {
  logger.info(`H_CHAT backend listening on http://${config.HOST}:${config.PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  io.close();
  httpServer.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
