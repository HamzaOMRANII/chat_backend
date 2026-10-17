import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

/**
 * A voice or video call: who, when, how long. Audio and video go straight between the devices (or through
 * the TURN relay), encrypted by WebRTC; nothing of it passes through or is stored by this server.
 */
const callSchema = new Schema(
  {
    participants: { type: [Schema.Types.ObjectId], ref: "User", required: true, index: true },
    startedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["voice", "video"], required: true },
    status: { type: String, enum: ["ringing", "active", "ended"], required: true },
    ringingAt: { type: Date, default: () => new Date() },
    answeredAt: Date,
    endedAt: Date,
    endReason: String,
    endedBy: { type: Schema.Types.ObjectId, ref: "User" },
    purgeAt: Date,
  },
  { timestamps: true },
);
callSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type CallDoc = HydratedDocument<InferSchemaType<typeof callSchema>>;
export const Call = model("Call", callSchema);
