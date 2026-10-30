import { Schema, model } from "mongoose";

/** Backoffice settings that aren't categories (for now: the oldest Android app version still allowed). */
const settingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: Schema.Types.Mixed,
  at: { type: Date, default: () => new Date() },
});
export const Setting = model("Setting", settingSchema);

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const s = await Setting.findOne({ key }).lean();
  return (s?.value as T | undefined) ?? fallback;
}
export async function setSetting(key: string, value: unknown) {
  await Setting.updateOne({ key }, { value, at: new Date() }, { upsert: true });
}
