import { Schema, model } from "mongoose";

/** One "add contact" attempt; counts toward the hourly limit, then expires. */
const lookupSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  at: { type: Date, default: () => new Date() },
});
lookupSchema.index({ at: 1 }, { expireAfterSeconds: 3600 });

export const Lookup = model("Lookup", lookupSchema);
