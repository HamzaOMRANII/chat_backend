import { Schema, model } from "mongoose";

/** A user's one-time invite code: whoever enters it becomes their contact. One active code per user, 24 h. */
const inviteSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  code: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
});
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Invite = model("Invite", inviteSchema);
