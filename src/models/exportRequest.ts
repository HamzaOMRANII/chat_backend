import { Schema, model, type InferSchemaType, type HydratedDocument, type Types } from "mongoose";

/**
 * A request to export a chat. The other participant approves or refuses; once approved, the requester has 24 hours
 * to build the zip on their device (the server never sees its content). Only the request is stored here.
 */
const exportSchema = new Schema(
  {
    chatId: { type: Schema.Types.ObjectId, ref: "Chat", required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approverId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    messages: { type: Boolean, required: true },
    media: { type: Boolean, required: true },
    period: { type: String, enum: ["all", "24h", "7d"], required: true },
    // What it covered when asked (shown to the approver)
    counts: { messages: Number, files: Number, bytes: Number },
    status: { type: String, enum: ["pending", "approved", "refused", "expired", "cancelled"], required: true, index: true },
    requestedAt: { type: Date, default: () => new Date() },
    answeredAt: Date,
    // Pending: until the approver must answer. Approved: until the requester can build it.
    until: { type: Date, required: true },
    downloadedAt: Date,
    purgeAt: Date,
  },
  { timestamps: true },
);
exportSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type ExportDoc = HydratedDocument<InferSchemaType<typeof exportSchema>>;
export type ExportFields = InferSchemaType<typeof exportSchema> & { _id: Types.ObjectId };
export const ExportRequest = model("ExportRequest", exportSchema);
