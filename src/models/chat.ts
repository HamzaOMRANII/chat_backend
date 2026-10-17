import { Schema, model, type InferSchemaType, type HydratedDocument, type Types } from "mongoose";

export const STORED_MODES = ["keep", "auto"] as const;
export type StoredMode = (typeof STORED_MODES)[number];
/** How long each message stays, in minutes: the choices offered for Keep-alive (Automatic is always 7 days). */
export const RETENTION_MINUTES = [30, 60, 180, 360, 720, 1440, 2880, 4320, 5760, 7200, 8640, 10080] as const;
export const AUTO_MINUTES = 10080;

/**
 * One participant's public chat key (X25519), signed by their device identity key.
 * A new version is added when the participant moves to a new device; older versions stay so the
 * other side can still read what was sent before. Private keys never leave the devices.
 */
const chatKeySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    version: { type: Number, required: true },
    pub: { type: String, required: true },
    sig: { type: String, required: true },
    // The identity key that signed it, as published when the key was added
    identityPub: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/**
 * A stored-mode chat between two contacts. invited → active → ended. At most one open (invited/active)
 * chat per pair. Ended chats keep their metadata 30 days for the backoffice; their messages are gone.
 */
const chatSchema = new Schema(
  {
    participants: { type: [Schema.Types.ObjectId], ref: "User", required: true },
    pairKey: { type: String, required: true, index: true },
    mode: { type: String, enum: STORED_MODES, required: true },
    retentionMinutes: { type: Number, enum: [...RETENTION_MINUTES] as number[], required: true },
    status: { type: String, enum: ["invited", "active", "ended"], required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Category whose rules applied when the chat started (admin metadata, never shown to users)
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    keys: { type: [chatKeySchema], default: [] },
    invitedAt: { type: Date, default: () => new Date() },
    inviteExpiresAt: Date,
    acceptedAt: Date,
    endedAt: Date,
    endedBy: { type: Schema.Types.ObjectId, ref: "User" },
    endReason: String,
    lastMessageAt: Date,
    messageCount: { type: Number, default: 0 },
    storedBytes: { type: Number, default: 0 },
    // Ended chats' metadata disappears after 30 days
    purgeAt: Date,
  },
  { timestamps: true },
);
chatSchema.index({ participants: 1, status: 1 });
// One open chat per pair
chatSchema.index({ pairKey: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["invited", "active"] } }, name: "one_open_chat_per_pair" });
chatSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type ChatFields = InferSchemaType<typeof chatSchema> & { _id: Types.ObjectId };
export type ChatDoc = HydratedDocument<InferSchemaType<typeof chatSchema>>;
export const Chat = model("Chat", chatSchema);
