import { Schema, model } from "mongoose";

/** Every backoffice action: who, what, on whom, when. Kept 90 days. */
const adminLogSchema = new Schema({
  adminId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  action: { type: String, required: true },
  targetUserId: { type: Schema.Types.ObjectId, ref: "User" },
  details: Schema.Types.Mixed,
  at: { type: Date, default: () => new Date() },
});
adminLogSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AdminLog = model("AdminLog", adminLogSchema);
