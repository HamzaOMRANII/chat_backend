// Creates (or resets) a backoffice administrator. Usage:
//   npm run create-admin -- <username> <email>
// The password is read from the ADMIN_PASSWORD environment variable, or a random one is generated
// and printed once. Sign-in also needs the 6-digit code sent to <email>.
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { loadConfig } from "../config/env.js";
import { hashSecret, numericCode } from "../lib/secrets.js";
import { emailSchema, usernameSchema } from "../lib/validate.js";
import { User } from "../models/user.js";

const [rawUsername, rawEmail] = process.argv.slice(2);
if (!rawUsername || !rawEmail) {
  console.error("Usage: npm run create-admin -- <username> <email>");
  process.exit(1);
}
const username = usernameSchema.parse(rawUsername);
const email = emailSchema.parse(rawEmail);
const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");
if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");

const config = loadConfig();
await mongoose.connect(config.MONGO_URI);
const existing = await User.findOne({ username });
if (existing && existing.role !== "admin") throw new Error(`"${username}" is a chat user, pick another admin username`);
await User.findOneAndUpdate(
  { username },
  {
    username,
    email,
    role: "admin",
    status: "approved",
    passwordHash: await hashSecret(password),
    // Admins never use the recovery passcode; a random one keeps the field filled
    passcodeHash: await hashSecret(numericCode(8)),
    approvedAt: new Date(),
    failedAttempts: 0,
    $unset: { lockedUntil: 1 },
  },
  { upsert: true, setDefaultsOnInsert: true },
);
console.log(`Administrator "${username}" ready (codes go to ${email}).`);
if (generated) console.log(`Password (shown once): ${password}`);
await mongoose.disconnect();
