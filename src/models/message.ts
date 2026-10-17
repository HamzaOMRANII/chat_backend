import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * A stored-mode message: ciphertext only (XChaCha20-Poly1305, encrypted on the sender's device).
 * The key versions say which pair of chat keys it was encrypted with. Deleted at expiresAt by MongoDB.
 */
const messageSchema = new Schema({
  chatId: { type: Schema.Types.ObjectId, ref: "Chat", required: true },
  senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  recipientId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  ciphertext: { type: String, required: true },
  nonce: { type: String, required: true },
  senderKeyVersion: { type: Number, required: true },
  recipientKeyVersion: { type: Number, required: true },
  size: { type: Number, required: true },
  // A file sent with this message (its key and name are inside the ciphertext)
  fileId: { type: Schema.Types.ObjectId, ref: "File" },
  sentAt: { type: Date, default: () => new Date() },
  deliveredAt: Date,
  readAt: Date,
  expiresAt: { type: Date, required: true },
});
messageSchema.index({ chatId: 1, sentAt: -1 });
messageSchema.index({ recipientId: 1, readAt: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type MessageFields = InferSchemaType<typeof messageSchema>;
export const Message = model("Message", messageSchema);
