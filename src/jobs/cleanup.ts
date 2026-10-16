import { logger } from "../lib/logger.js";
import { User } from "../models/user.js";

const REJECTED_KEEP_DAYS = 7;

/** Rejected sign-up requests are deleted after 7 days. Runs hourly. */
export async function cleanupOnce() {
  const cutoff = new Date(Date.now() - REJECTED_KEEP_DAYS * 24 * 3600_000);
  const { deletedCount } = await User.deleteMany({ role: "user", status: "rejected", rejectedAt: { $lt: cutoff } });
  if (deletedCount) logger.info({ deletedCount }, "deleted old rejected requests");
}

export function startCleanupJob() {
  const run = () => void cleanupOnce().catch((err) => logger.error({ err }, "cleanup failed"));
  run();
  return setInterval(run, 60 * 60_000);
}
