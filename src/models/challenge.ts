import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

/**
 * Second sign-in step after a correct password: an email code (or, instead, the recovery passcode).
 * Also used to confirm a new email address. Expires after a few minutes; attempts are capped.
 */
const challengeSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  purpose: { type: String, enum: ["login", "admin-login", "email-change"], required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  newEmail: String,
  device: { type: Schema.Types.Mixed },
  expiresAt: { type: Date, required: true },
});
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type ChallengeDoc = HydratedDocument<InferSchemaType<typeof challengeSchema>>;
export const Challenge = model("Challenge", challengeSchema);
