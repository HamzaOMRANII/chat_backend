import { Schema, model, type InferSchemaType, type HydratedDocument, type Types } from "mongoose";
import { RETENTION_MINUTES } from "./chat.js";

/** At most this many people in a group. */
export const GROUP_MAX_MEMBERS = 10;

/**
 * A group, created and managed by the administrator. Each member publishes a group key (X25519, signed by their
 * device identity); every message is locked for each current member's key, so someone removed reads nothing new.
 */
const groupKeySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    version: { type: Number, required: true },
    pub: { type: String, required: true },
    sig: { type: String, required: true },
    identityPub: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const groupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // pending: asked by a user, waiting for the administrator · active · refused (kept 30 days for the asker)
    status: { type: String, enum: ["pending", "active", "refused"], default: "active", index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User" },
    refusedAt: Date,
    purgeAt: Date,
    // Set by the administrator (on creation, or when approving a request)
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    mode: { type: String, enum: ["keep", "auto"] },
    retentionMinutes: { type: Number, enum: [...RETENTION_MINUTES] as number[] },
    members: { type: [Schema.Types.ObjectId], ref: "User", default: [], index: true },
    keys: { type: [groupKeySchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    lastMessageAt: Date,
    messageCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

groupSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type GroupDoc = HydratedDocument<InferSchemaType<typeof groupSchema>>;
export type GroupFields = InferSchemaType<typeof groupSchema> & { _id: Types.ObjectId; createdAt: Date };
export const Group = model("Group", groupSchema);

/**
 * A group message: the text (and any file's key) encrypted once with a random message key; that key is locked
 * ("wrapped") for each member's group key. System lines ("added rami.t") carry no secret and no ciphertext.
 */
const wrapSchema = new Schema(
  { userId: { type: Schema.Types.ObjectId, required: true }, keyVersion: { type: Number, required: true }, key: { type: String, required: true } },
  { _id: false },
);
const groupMessageSchema = new Schema({
  groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
  senderId: { type: Schema.Types.ObjectId, ref: "User" },
  senderKeyVersion: Number,
  ciphertext: String,
  nonce: String,
  wraps: { type: [wrapSchema], default: undefined },
  system: { type: { kind: String, userId: Schema.Types.ObjectId, name: String }, default: undefined, _id: false },
  fileId: { type: Schema.Types.ObjectId, ref: "File" },
  size: { type: Number, default: 0 },
  readBy: { type: [Schema.Types.ObjectId], default: [] },
  sentAt: { type: Date, default: () => new Date() },
  expiresAt: { type: Date, required: true },
});
groupMessageSchema.index({ groupId: 1, sentAt: -1 });
groupMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const GroupMessage = model("GroupMessage", groupMessageSchema);
