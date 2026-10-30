import { Router } from "express";
import type { Config } from "../../config/env.js";
import type { Mailer } from "../../lib/mailer.js";
import { createAdminContext } from "./context.js";
import { registerAuth } from "./auth.js";
import { registerUsers } from "./users.js";
import { registerContacts } from "./contacts.js";
import { registerDashboard } from "./dashboard.js";
import { registerChats } from "./chats.js";
import { registerGroups } from "./groups.js";
import { registerStorage } from "./storage.js";
import { registerLive } from "./live.js";
import { registerCategories } from "./categories.js";
import { registerLogs } from "./logs.js";
import { registerSettings } from "./settings.js";

/**
 * The backoffice API, mounted at /api/admin (only reachable through adminchat.omranisystems.com).
 * One file per backoffice section; every route except sign-in is guarded by `admin`.
 */
export function createAdminRouter(config: Config, mailer: Mailer) {
  const router = Router();
  const ctx = createAdminContext(config, mailer);
  registerAuth(router, ctx);
  registerUsers(router, ctx);
  registerContacts(router, ctx);
  registerDashboard(router, ctx);
  registerChats(router, ctx);
  registerGroups(router, ctx);
  registerStorage(router, ctx);
  registerLive(router, ctx);
  registerCategories(router, ctx);
  registerLogs(router, ctx);
  registerSettings(router, ctx);
  return router;
}
