import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * A browser's Web Push subscription, tied to the session that made it: signing out or being signed out
 * elsewhere ends it. The endpoint belongs to the browser's push service; payloads are encrypted for the browser.
 */
const pushSubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "Session", required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  { timestamps: true },
);

export type PushSubscriptionFields = InferSchemaType<typeof pushSubscriptionSchema>;
export const PushSubscription = model("PushSubscription", pushSubscriptionSchema);
