import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export const hashSecret = (value: string) => argon2.hash(value, { type: argon2.argon2id });

export async function verifySecret(hash: string | undefined | null, value: string) {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, value);
  } catch {
    return false;
  }
}

/** Numeric one-time code, e.g. the 6-digit email code. */
export function numericCode(length: number) {
  let code = "";
  for (let i = 0; i < length; i++) code += randomInt(0, 10).toString();
  return code;
}

// Short-lived codes are compared by SHA-256 (they expire in minutes and attempts are capped).
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function sameHash(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** "leila@example.com" -> "l•••a@example.com" */
export function maskEmail(email: string) {
  const [name = "", domain = ""] = email.split("@");
  const visible = name.length <= 2 ? name.slice(0, 1) : `${name[0]}•••${name[name.length - 1]}`;
  return `${visible}@${domain}`;
}
