import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const CHAT_MODES = ["live", "keep", "auto"] as const;

const rulesSchema = new Schema(
  {
    modes: { type: [String], enum: CHAT_MODES, default: ["live", "keep", "auto"] },
    maxRetentionDays: { type: Number, min: 0, max: 7, default: 7 },
    files: { type: String, enum: ["all", "p2p", "none"], default: "all" },
    export: { type: Boolean, default: true },
    calls: { type: String, enum: ["none", "voice", "video"], default: "video" },
  },
  { _id: false },
);

/** Admin-only grouping: two users can be friends only if they share a category. Users never see these. */
const categorySchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    order: { type: Number, required: true },
    rules: { type: rulesSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export type CategoryDoc = HydratedDocument<InferSchemaType<typeof categorySchema>>;
export const Category = model("Category", categorySchema);

/** Initial categories (design §4.2); created once when the collection is empty. */
export const DEFAULT_CATEGORIES = [
  { name: "Family", rules: { modes: ["live", "keep", "auto"], maxRetentionDays: 7, files: "all", export: true, calls: "video" } },
  { name: "Friends", rules: { modes: ["live", "keep", "auto"], maxRetentionDays: 7, files: "all", export: true, calls: "video" } },
  { name: "Pro", rules: { modes: ["live", "keep", "auto"], maxRetentionDays: 7, files: "all", export: true, calls: "video" } },
  { name: "Externals", rules: { modes: ["keep"], maxRetentionDays: 3, files: "none", export: false, calls: "voice" } },
  { name: "Secret", rules: { modes: ["live"], maxRetentionDays: 0, files: "p2p", export: false, calls: "video" } },
  { name: "Confidential", rules: { modes: ["live", "keep"], maxRetentionDays: 1, files: "all", export: false, calls: "video" } },
] as const;

export async function seedCategories() {
  if (await Category.estimatedDocumentCount()) return;
  await Category.insertMany(DEFAULT_CATEGORIES.map((c, i) => ({ ...c, order: i + 1 })));
}
