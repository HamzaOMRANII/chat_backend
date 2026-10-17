import { Schema, model, type InferSchemaType, type HydratedDocument, type Types } from "mongoose";

export const FILE_KINDS = ["image", "video", "audio", "document", "archive", "other"] as const;

/**
 * A file sent in a stored chat. Encrypted on the phone before upload, in pieces: the server only ever holds
 * scrambled bytes on disk (MEDIA_DIR/<id>/<n>). Its name, type and key travel inside the end-to-end encrypted
 * message; only the coarse kind and the size are visible here. Deleted with its message (expiresAt), when the
 * chat ends, by a participant, or by the administrator.
 */
const fileSchema = new Schema(
  {
    // A stored chat's file, or a group's (then every member may fetch it)
    chatId: { type: Schema.Types.ObjectId, ref: "Chat", index: true },
    groupId: { type: Schema.Types.ObjectId, ref: "Group", index: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    recipientId: { type: Schema.Types.ObjectId, ref: "User" },
    kind: { type: String, enum: FILE_KINDS, required: true },
    // Encrypted size on disk (all pieces), and how many pieces
    size: { type: Number, required: true },
    chunks: { type: Number, required: true },
    // Pieces already uploaded
    got: { type: [Number], default: [] },
    status: { type: String, enum: ["uploading", "ready", "deleted"], required: true, index: true },
    messageId: { type: Schema.Types.ObjectId, ref: "Message" },
    // Same as its message; until it's sent: abandoned uploads are cleaned after an hour
    expiresAt: { type: Date, required: true, index: true },
    deletedAt: Date,
    deletedReason: String,
    // Deleted file records stay a day so the chats can show "removed"
    purgeAt: Date,
  },
  { timestamps: true },
);
fileSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type FileDoc = HydratedDocument<InferSchemaType<typeof fileSchema>>;
export type FileFields = InferSchemaType<typeof fileSchema> & { _id: Types.ObjectId; createdAt: Date };
export const StoredFile = model("File", fileSchema);
