import { Schema, model, type InferSchemaType, type HydratedDocument, type Types } from "mongoose";

/**
 * A live chat between two contacts: invited → active → ended. Only metadata lives here (who, when, how long);
 * what is typed passes through the server encrypted and is never stored. At most one open live chat per pair,
 * and it can run next to a stored chat with the same person.
 */
const liveSchema = new Schema(
  {
    participants: { type: [Schema.Types.ObjectId], ref: "User", required: true },
    pairKey: { type: String, required: true },
    status: { type: String, enum: ["invited", "active", "ended"], required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    // Public session keys (X25519, signed by each device identity); deleted when it ends
    keys: {
      type: [new Schema({ userId: { type: Schema.Types.ObjectId, required: true }, pub: String, sig: String, identityPub: String }, { _id: false })],
      default: [],
    },
    invitedAt: { type: Date, default: () => new Date() },
    inviteExpiresAt: Date,
    startedAt: Date,
    endedAt: Date,
    endedBy: { type: Schema.Types.ObjectId, ref: "User" },
    endReason: String,
    // Ended sessions keep their metadata 30 days for the backoffice
    purgeAt: Date,
  },
  { timestamps: true },
);
liveSchema.index({ participants: 1, status: 1 });
liveSchema.index({ pairKey: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["invited", "active"] } }, name: "one_open_live_per_pair" });
liveSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type LiveFields = InferSchemaType<typeof liveSchema> & { _id: Types.ObjectId };
export type LiveDoc = HydratedDocument<InferSchemaType<typeof liveSchema>>;
export const LiveSession = model("LiveSession", liveSchema);
