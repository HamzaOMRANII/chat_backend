import type { Router } from "express";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { objectIdSchema, parse } from "../../lib/validate.js";
import { Category } from "../../models/category.js";
import { User } from "../../models/user.js";
import { reconcileAllChats } from "../chats/service.js";
import { type AdminContext, rulesSchema } from "./context.js";

/** Categories: the rules that decide who may talk to whom, and how. */
export function registerCategories(router: Router, { admin, log }: AdminContext) {
  router.get("/categories", admin, async (_req, res) => {
    const [categories, members] = await Promise.all([
      Category.find().sort({ order: 1 }).lean(),
      User.aggregate([{ $match: { role: "user", status: { $in: ["approved", "suspended"] } } }, { $unwind: "$categoryIds" }, { $group: { _id: "$categoryIds", n: { $sum: 1 } } }]),
    ]);
    const count = new Map(members.map((m) => [String(m._id), m.n]));
    res.json({ categories: categories.map((c) => ({ id: String(c._id), name: c.name, order: c.order, rules: c.rules, members: count.get(String(c._id)) ?? 0 })) });
  });

  router.get("/categories/:id/members", admin, async (req, res) => {
    const id = parse(objectIdSchema, req.params.id);
    const users = await User.find({ role: "user", categoryIds: id }).select("username status").sort({ username: 1 }).lean();
    res.json({ members: users.map((u) => ({ id: String(u._id), username: u.username, status: u.status })) });
  });

  router.post("/categories", admin, async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(40), rules: rulesSchema }), req.body);
    if (await Category.exists({ name: body.name })) throw conflict("A category with this name exists.");
    const last = await Category.findOne().sort({ order: -1 }).lean();
    const category = await Category.create({ ...body, order: (last?.order ?? 0) + 1 });
    await log(req, "category.created", undefined, { name: body.name });
    res.status(201).json({ id: category.id });
  });

  router.patch("/categories/:id", admin, async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), rules: rulesSchema.optional() }), req.body);
    const category = await Category.findById(parse(objectIdSchema, req.params.id));
    if (!category) throw notFound("Category not found");
    if (body.name && body.name !== category.name && (await Category.exists({ name: body.name }))) throw conflict("A category with this name exists.");
    if (body.name) category.name = body.name;
    if (body.rules) category.set("rules", body.rules);
    await category.save();
    // Open chats that break the new rules end now
    await reconcileAllChats();
    await log(req, "category.updated", undefined, { id: category.id, ...body });
    res.json({ ok: true });
  });

  router.post("/categories/reorder", admin, async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(objectIdSchema).min(1) }), req.body);
    if ((await Category.countDocuments()) !== ids.length || (await Category.countDocuments({ _id: { $in: ids } })) !== ids.length) {
      throw badRequest("Send every category exactly once.");
    }
    await Category.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { order: i + 1 } } })));
    // The order picks which shared category applies to a pair: chats that no longer fit end
    await reconcileAllChats();
    await log(req, "category.reordered", undefined, { ids });
    res.json({ ok: true });
  });

  router.delete("/categories/:id", admin, async (req, res) => {
    const id = parse(objectIdSchema, req.params.id);
    if (await User.exists({ categoryIds: id })) throw conflict("Remove everyone from this category first.", "category_in_use");
    const category = await Category.findByIdAndDelete(id);
    if (!category) throw notFound("Category not found");
    await log(req, "category.deleted", undefined, { name: category.name });
    res.json({ ok: true });
  });
}
