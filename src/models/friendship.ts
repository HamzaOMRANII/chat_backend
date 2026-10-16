import { Schema, Types, model, type InferSchemaType, type HydratedDocument } from "mongoose";

/**
 * One document per pair of users, whatever its state. `userA` < `userB` (by id) so a pair has one key.
 * pending = a request sent with a personal ID; accepted = contacts. Declined requests are deleted.
 */
const friendshipSchema = new Schema(
  {
    userA: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userB: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    pairKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ["pending", "accepted"], required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    via: { type: String, enum: ["id", "invite"], required: true },
    // Set by the admin to pick which shared category's rules apply; otherwise the first shared one by order
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    acceptedAt: Date,
  },
  { timestamps: true },
);

export type FriendshipDoc = HydratedDocument<InferSchemaType<typeof friendshipSchema>>;
export const Friendship = model("Friendship", friendshipSchema);

export function pair(a: Types.ObjectId | string, b: Types.ObjectId | string) {
  const [userA, userB] = [String(a), String(b)].sort();
  return { userA: new Types.ObjectId(userA), userB: new Types.ObjectId(userB), pairKey: `${userA}:${userB}` };
}

/** The other side of a friendship, seen from `me`. */
export const otherUserId = (f: { userA: Types.ObjectId; userB: Types.ObjectId }, me: Types.ObjectId | string) =>
  String(f.userA) === String(me) ? f.userB : f.userA;
