import { Schema, model } from "mongoose";

/**
 * The Android app's Firebase Cloud Messaging token, tied to the session that registered it: signing out or being
 * signed out elsewhere deletes it. Used only when the app is closed or in the background.
 */
const fcmTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "Session", required: true, index: true },
    token: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);

export const FcmToken = model("FcmToken", fcmTokenSchema);
