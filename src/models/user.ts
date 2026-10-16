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
    delete ret.__v;
    return ret;
  },
});

export type UserFields = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserFields>;
export const User = model("User", userSchema);
