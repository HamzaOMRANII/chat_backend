import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const USER_STATUSES = ["pending", "approved", "rejected", "suspended"] as const;

const userSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    passcodeHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["user", "admin"], default: "user", index: true },
    status: { type: String, enum: USER_STATUSES, default: "pending", index: true },
    categoryIds: { type: [Schema.Types.ObjectId], ref: "Category", default: [] },
    // What others type to send a contact request (HC-XXXX-XXXX); given at approval, can be changed
    personalId: { type: String, unique: true, sparse: true },
    // The signed-in device's public identity key (Ed25519, base64). Changes when the account moves to a new device.
    identity: {
      deviceId: String,
      signPub: String,
      at: Date,
    },

    // Which events show a system notification (in-app banners always show)
    notify: {
      messages: { type: Boolean, default: true },
      chats: { type: Boolean, default: true },
      contacts: { type: Boolean, default: true },
    },

    // Off: nobody can call this user; callers are told they aren't taking calls (never why)
    receiveCalls: { type: Boolean, default: true },

    // The administrator asked this user to download their media before it's deleted
    mediaRequest: {
      deadline: Date,
      requestedAt: Date,
      reminded: { type: [String], default: undefined },
    },

    privacyAcceptedAt: Date,
    approvedAt: Date,
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    rejectedAt: Date,
    suspendedAt: Date,

    // Set after a recovery-passcode or admin-reset sign-in: new password + passcode required first
    mustReset: { type: Boolean, default: false },
    // One-time code the admin hands out when someone lost both email and passcode
    adminResetHash: { type: String, select: false },
    adminResetExpiresAt: Date,
    // Secure code: the user's own 8–12 digits, typed instead of the emailed code (hidden field, 5 taps).
    // Cleared by any credentials reset; the administrator can switch it off per user.
    secureCodeHash: { type: String, select: false },
    secureCodeSetAt: Date,
    secureCodeDisabled: { type: Boolean, default: false },

    failedAttempts: { type: Number, default: 0 },
    lockedUntil: Date,
    credentialsChangedAt: Date,

    activeSessionId: { type: Schema.Types.ObjectId, ref: "Session" },
    lastSeenAt: Date,
  },
  { timestamps: true },
);

userSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.passwordHash;
    delete ret.passcodeHash;
    delete ret.adminResetHash;
    delete ret.secureCodeHash;
    delete ret.__v;
    return ret;
  },
});

export type UserFields = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserFields>;
export const User = model("User", userSchema);
