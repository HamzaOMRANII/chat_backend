import { logger } from "../lib/logger.js";
import { User } from "../models/user.js";
import { expireChats } from "../modules/chats/service.js";
import { expireLive } from "../modules/live/service.js";

const REJECTED_KEEP_DAYS = 7;

/** Rejected sign-up requests are deleted after 7 days (hourly); unanswered chat invitations and emptied chats end (every minute: chats can last 30 min). */
export async function cleanupOnce() {
  const cutoff = new Date(Date.now() - REJECTED_KEEP_DAYS * 24 * 3600_000);
  const { deletedCount } = await User.deleteMany({ role: "user", status: "rejected", rejectedAt: { $lt: cutoff } });
  if (deletedCount) logger.info({ deletedCount }, "deleted old rejected requests");
  await expireChats();
  await expireLive();
}

export function startCleanupJob() {
  const run = () => void cleanupOnce().catch((err) => logger.error({ err }, "cleanup failed"));
  const chats = () => void Promise.all([expireChats(), expireLive()]).catch((err) => logger.error({ err }, "chat expiry failed"));
  run();
  const hourly = setInterval(run, 60 * 60_000);
  const minutely = setInterval(chats, 60_000);
  return { close: () => (clearInterval(hourly), clearInterval(minutely)) };
}
