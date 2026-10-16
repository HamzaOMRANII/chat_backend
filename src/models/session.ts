import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

const deviceSchema = new Schema(
  {
    deviceId: String,
    name: String,
    platform: String,
    model: String,
    osVersion: String,
    appVersion: String,
    browser: String,
    os: String,
    ip: String,
    country: String,
    city: String,
  },
  { _id: false },
);

/**
 * One row per sign-in. "user" sessions are full access; "reset" sessions may only set new
 * credentials; "admin" sessions belong to the backoffice. A user has at most one live "user" session.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["user", "reset", "admin"], required: true },
    device: deviceSchema,
    revokedAt: Date,
    revokeReason: { type: String, enum: ["new_login", "logout", "suspended", "admin", "credentials_changed", "deleted"] },
    revokedBy: deviceSchema,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
// Expired sessions disappear a day after they end (revoked ones stay until then for the "kicked" screen)
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export type SessionDoc = HydratedDocument<InferSchemaType<typeof sessionSchema>>;
export const Session = model("Session", sessionSchema);
