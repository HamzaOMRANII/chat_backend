import { logger } from "../lib/logger.js";
import { User } from "../models/user.js";
import { expireChats } from "../modules/chats/service.js";

const REJECTED_KEEP_DAYS = 7;

/** Rejected sign-up requests are deleted after 7 days; unanswered chat invitations and emptied chats end. Runs hourly. */
export async function cleanupOnce() {
  const cutoff = new Date(Date.now() - REJECTED_KEEP_DAYS * 24 * 3600_000);
  const { deletedCount } = await User.deleteMany({ role: "user", status: "rejected", rejectedAt: { $lt: cutoff } });
  if (deletedCount) logger.info({ deletedCount }, "deleted old rejected requests");
  await expireChats();
}

export function startCleanupJob() {
  const run = () => void cleanupOnce().catch((err) => logger.error({ err }, "cleanup failed"));
  run();
  return setInterval(run, 60 * 60_000);
}
