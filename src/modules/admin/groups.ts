import type { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { badRequest, notFound } from "../../lib/errors.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { auth } from "../../middleware/auth.js";
import { Category } from "../../models/category.js";
import { User } from "../../models/user.js";
import { Group, GROUP_MAX_MEMBERS, type GroupDoc, type GroupFields } from "../../models/group.js";
import { deleteGroup, dropMember, systemLine } from "../groups/service.js";
import { AUTO_MINUTES } from "../../models/chat.js";
import { notify } from "../notify/service.js";
import type { AdminContext } from "./context.js";

/** Groups: made by the administrator, or asked by a user and approved here. */
export function registerGroups(router: Router, { admin, log }: AdminContext) {
  async function groupRows(groups: GroupFields[]) {
    const users = await User.find({ _id: { $in: groups.flatMap((g) => [...g.members, ...(g.requestedBy ? [g.requestedBy] : [])]) } })
      .select("username")
      .lean();
    const names = new Map(users.map((u) => [String(u._id), u.username]));
    const categories = await Category.find().select("name").lean();
    return groups.map((g) => ({
      id: String(g._id),
      name: g.name,
      status: g.status,
      categoryId: g.categoryId ? String(g.categoryId) : null,
      category: g.categoryId ? (categories.find((c) => String(c._id) === String(g.categoryId))?.name ?? null) : null,
      mode: g.mode ?? null,
      retentionMinutes: g.retentionMinutes ?? null,
      members: g.members.map((m) => ({ id: String(m), username: names.get(String(m)) ?? "deleted user" })),
      requestedBy: g.requestedBy ? (names.get(String(g.requestedBy)) ?? null) : null,
      createdAt: g.createdAt,
      lastMessageAt: g.lastMessageAt ?? null,
      messageCount: g.messageCount ?? 0,
    }));
  }

  router.get("/groups", admin, async (_req, res) => {
    const groups = await Group.find({ status: { $in: ["pending", "active"] } })
      .sort({ status: -1, lastMessageAt: -1, createdAt: -1 })
      .lean<GroupFields[]>();
    res.json({ groups: await groupRows(groups), pending: groups.filter((g) => g.status === "pending").length });
  });

  /** Name, rules and members, checked: approved users, at most 10, a duration the category allows. */
  async function groupSettings(body: { name?: string; categoryId?: string; retentionMinutes?: number; memberIds?: string[] }, current?: GroupFields) {
    const categoryId = body.categoryId ?? (current?.categoryId ? String(current.categoryId) : undefined);
    const retentionMinutes = body.retentionMinutes ?? current?.retentionMinutes ?? undefined;
    if (!categoryId || !retentionMinutes) throw badRequest("Choose the category and how long messages stay.");
    const category = await Category.findById(categoryId).lean();
    if (!category) throw badRequest("Unknown category", "unknown_category");
    const modes = category.rules?.modes ?? [];
    const max = (category.rules?.maxRetentionDays ?? 0) * 1440;
    const auto = retentionMinutes === AUTO_MINUTES && modes.includes("auto");
    if (!auto && (!modes.includes("keep") || retentionMinutes > max))
      throw badRequest(`${category.name} doesn't allow messages to stay that long.`, "mode_not_allowed");
    let members = current?.members.map(String) ?? [];
    if (body.memberIds) {
      members = [...new Set(body.memberIds)];
      if (members.length > GROUP_MAX_MEMBERS) throw badRequest(`A group has at most ${GROUP_MAX_MEMBERS} people.`, "too_many_members");
      const ok = await User.countDocuments({ _id: { $in: members }, role: "user", status: "approved" });
      if (ok !== members.length) throw badRequest("Some of these people aren't approved users.", "bad_members");
    }
    return {
      name: body.name ?? current?.name,
      categoryId: new Types.ObjectId(categoryId),
      mode: (auto ? "auto" : "keep") as "auto" | "keep",
      retentionMinutes,
      members,
    };
  }

  /** Who joined and who left: system lines, notifications, removed members' keys dropped. */
  async function applyMembers(group: GroupDoc, before: string[], after: string[]) {
    const added = after.filter((m) => !before.includes(m));
    const removed = before.filter((m) => !after.includes(m));
    const people = await User.find({ _id: { $in: [...added, ...removed] } })
      .select("username")
      .lean();
    for (const id of removed) {
      await dropMember(group, id);
      await systemLine(group, "removed", people.find((p) => String(p._id) === id) as never);
    }
    if (added.length) {
      group.set(
        "members",
        [...group.members.map(String).filter((m) => !added.includes(m)), ...added].map((m) => new Types.ObjectId(m)),
      );
      await group.save();
      for (const id of added) {
        await systemLine(group, "added", people.find((p) => String(p._id) === id) as never);
        void notify(id, {
          kind: "contact_added",
          title: group.name,
          body: "You were added to this group.",
          tag: `group:${group.id}`,
          open: { groupId: group.id },
        });
      }
    }
  }

  const groupBody = z.object({
    name: z.string().trim().min(2).max(60).optional(),
    categoryId: objectIdSchema.optional(),
    retentionMinutes: z.number().int().optional(),
    memberIds: z.array(objectIdSchema).max(100).optional(),
  });

  router.post("/groups", admin, async (req, res) => {
    const body = parse(groupBody.required({ name: true, memberIds: true }), req.body);
    const settings = await groupSettings(body);
    const { members: _members, ...rest } = settings;
    const group = await Group.create({ ...rest, members: [], status: "active", createdBy: auth(req).user._id });
    await systemLine(group, "created");
    await applyMembers(group, [], settings.members);
    await log(req, "group.created", undefined, { name: group.name, members: settings.members.length });
    res.status(201).json({ group: (await groupRows([group.toObject() as GroupFields]))[0] });
  });

  // Edit a group, or approve a user's request (status pending → active)
  router.put("/groups/:id", admin, async (req, res) => {
    const body = parse(groupBody, req.body);
    const group = await Group.findById(parse(objectIdSchema, req.params.id));
    if (!group || group.status === "refused") throw notFound("Group not found");
    const before = group.status === "active" ? group.members.map(String) : [];
    const settings = await groupSettings(body, group.toObject() as GroupFields);
    const approving = group.status === "pending";
    group.set({ name: settings.name, categoryId: settings.categoryId, mode: settings.mode, retentionMinutes: settings.retentionMinutes, status: "active" });
    if (approving) group.set("members", []);
    await group.save();
    if (approving) await systemLine(group, "created");
    else if (!body.memberIds) await systemLine(group, "settings");
    await applyMembers(group, before, settings.members);
    if (approving && group.requestedBy)
      void notify(group.requestedBy, {
        kind: "contact_added",
        title: group.name,
        body: "Your group was approved.",
        tag: `group:${group.id}`,
        open: { groupId: group.id },
      });
    await log(req, approving ? "group.approved" : "group.updated", undefined, { name: group.name, members: settings.members.length });
    res.json({ group: (await groupRows([group.toObject() as GroupFields]))[0] });
  });

  router.post("/groups/:id/refuse", admin, async (req, res) => {
    const group = await Group.findOne({ _id: parse(objectIdSchema, req.params.id), status: "pending" });
    if (!group) throw notFound("Request not found");
    group.status = "refused";
    group.refusedAt = new Date();
    group.purgeAt = new Date(Date.now() + 30 * 864e5);
    await group.save();
    if (group.requestedBy)
      void notify(group.requestedBy, {
        kind: "contact_added",
        title: group.name,
        body: "The administrator didn't approve this group.",
        tag: `group:${group.id}`,
        open: {},
      });
    await log(req, "group.refused", group.requestedBy ?? undefined, { name: group.name });
    res.json({ ok: true });
  });

  router.delete("/groups/:id", admin, async (req, res) => {
    const group = await Group.findById(parse(objectIdSchema, req.params.id));
    if (!group) throw notFound("Group not found");
    await deleteGroup(group);
    await log(req, "group.deleted", undefined, { name: group.name });
    res.json({ ok: true });
  });
}
