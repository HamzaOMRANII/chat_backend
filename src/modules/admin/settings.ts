import type { Router } from "express";
import { z } from "zod";
import { parse } from "../../lib/validate.js";
import { auth } from "../../middleware/auth.js";
import { Category } from "../../models/category.js";
import { User } from "../../models/user.js";
import { Group, GROUP_MAX_MEMBERS } from "../../models/group.js";
import { systemLine } from "../groups/service.js";
import { AUTO_MINUTES } from "../../models/chat.js";
import { getSetting, setSetting } from "../../models/setting.js";
import { reconcileAllChats } from "../chats/service.js";
import { type AdminContext, rulesSchema } from "./context.js";

/** Settings, backup and restore (never messages: they're end-to-end encrypted). */
export function registerSettings(router: Router, { admin, log }: AdminContext) {
  router.get("/settings", admin, async (_req, res) => {
    res.json({ minAppVersion: await getSetting("minAppVersion", "0.0.0") });
  });

  router.put("/settings", admin, async (req, res) => {
    const { minAppVersion } = parse(z.object({ minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "Use a version like 1.0.0") }), req.body);
    await setSetting("minAppVersion", minAppVersion);
    await log(req, "settings.min_version", undefined, { minAppVersion });
    res.json({ minAppVersion });
  });

  /** Everything the backoffice configures: categories and their rules, groups and their members, settings. */
  router.get("/backup", admin, async (req, res) => {
    const [categories, groups] = await Promise.all([Category.find().sort({ order: 1 }).lean(), Group.find({ status: "active" }).lean()]);
    const users = await User.find({ _id: { $in: groups.flatMap((g) => g.members) } }).select("username").lean();
    const name = (id: unknown) => users.find((u) => String(u._id) === String(id))?.username;
    const backup = {
      app: "H_CHAT",
      kind: "settings-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { minAppVersion: await getSetting("minAppVersion", "0.0.0") },
      categories: categories.map((c) => ({ name: c.name, order: c.order, rules: c.rules })),
      groups: groups.map((g) => ({
        name: g.name,
        category: categories.find((c) => String(c._id) === String(g.categoryId))?.name ?? null,
        retentionMinutes: g.retentionMinutes,
        members: g.members.map(name).filter(Boolean),
      })),
    };
    await log(req, "settings.backup", undefined, { categories: backup.categories.length, groups: backup.groups.length });
    res.setHeader("Content-Disposition", `attachment; filename="h_chat-settings-${backup.exportedAt.slice(0, 10)}.json"`);
    res.json(backup);
  });

  /** Puts a backup back: categories by name (rules updated), settings, groups that don't exist yet. */
  router.post("/restore", admin, async (req, res) => {
    const body = parse(
      z.object({
        confirm: z.literal("RESTORE", { message: 'Type "RESTORE" to confirm.' }),
        backup: z.object({
          app: z.literal("H_CHAT"),
          kind: z.literal("settings-backup"),
          settings: z.object({ minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/) }).partial().optional(),
          categories: z.array(z.object({ name: z.string().min(1).max(40), order: z.number().int().optional(), rules: z.record(z.string(), z.unknown()) })).max(50),
          groups: z.array(z.object({ name: z.string().min(1).max(60), category: z.string().nullable(), retentionMinutes: z.number().int().nullable(), members: z.array(z.string()).max(20) })).max(500).default([]),
        }),
      }),
      req.body,
    );
    const b = body.backup;
    let categories = 0;
    for (const c of b.categories) {
      const parsed = parse(rulesSchema, c.rules);
      await Category.updateOne({ name: c.name }, { $set: { rules: parsed, ...(c.order !== undefined ? { order: c.order } : {}) } }, { upsert: true });
      categories++;
    }
    if (b.settings?.minAppVersion) await setSetting("minAppVersion", b.settings.minAppVersion);
    let groups = 0;
    const skipped: string[] = [];
    for (const g of b.groups) {
      if (await Group.exists({ name: g.name, status: "active" })) continue;
      const category = g.category ? await Category.findOne({ name: g.category }).lean() : null;
      const members = await User.find({ username: { $in: g.members }, role: "user", status: "approved" }).select("_id").lean();
      if (!category || !g.retentionMinutes || members.length < 2) {
        skipped.push(g.name);
        continue;
      }
      const created = await Group.create({ name: g.name, status: "active", categoryId: category._id, mode: g.retentionMinutes === AUTO_MINUTES ? "auto" : "keep", retentionMinutes: g.retentionMinutes, members: members.map((m) => m._id).slice(0, GROUP_MAX_MEMBERS), createdBy: auth(req).user._id });
      await systemLine(created, "created");
      groups++;
    }
    await reconcileAllChats();
    await log(req, "settings.restore", undefined, { categories, groups, skipped: skipped.length });
    res.json({ categories, groups, skipped });
  });
}
