import { Schema, model, type InferSchemaType } from "mongoose";

export const DEVICE_EVENT_TYPES = [
  "signup",
  "login",
  "logout",
  "kicked",
  "failed_password",
  "failed_code",
  "failed_passcode",
  "passcode_used",
  "admin_reset_used",
  "credentials_reset",
  "email_changed",
  "locked",
] as const;

/** Security log: every sign-in related event with device and network details. Kept 90 days. */
const deviceEventSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type: { type: String, enum: DEVICE_EVENT_TYPES, required: true },
  deviceId: String,
  deviceName: String,
  platform: String,
  model: String,
  manufacturer: String,
  osVersion: String,
  appVersion: String,
  network: String,
  browser: String,
  os: String,
  deviceType: String,
  screen: String,
  language: String,
  timezone: String,
  ip: String,
  country: String,
  city: String,
  at: { type: Date, default: () => new Date() },
});
deviceEventSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
deviceEventSchema.index({ userId: 1, at: -1 });

export type DeviceEventFields = InferSchemaType<typeof deviceEventSchema>;
export const DeviceEvent = model("DeviceEvent", deviceEventSchema);
