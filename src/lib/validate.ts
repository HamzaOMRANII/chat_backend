import { z } from "zod";
import { badRequest } from "./errors.js";

/** Parses a request body with a zod schema; the first problem becomes a 400 with a readable message. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join(".");
    throw badRequest(issue ? (field ? `${field}: ${issue.message}` : issue.message) : "Invalid request", "invalid_input");
  }
  return result.data;
}

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, "use 3 to 32 letters, digits, dots, dashes or underscores");
export const emailSchema = z.string().trim().toLowerCase().email("enter a valid email").max(254);
/** Sign-in accepts the username or the account email. */
export const loginIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => /^[a-z0-9._-]{3,32}$/.test(v) || emailSchema.safeParse(v).success, "enter your username or email");
export const loginFilter = (id: string) => (id.includes("@") ? { email: id } : { username: id });
export const passwordSchema = z.string().min(12, "use at least 12 characters").max(200);
export const passcodeSchema = z.string().regex(/^\d{8}$/, "the recovery passcode is exactly 8 digits");
export const codeSchema = z.string().regex(/^\d{6}$/, "the code is 6 digits");
export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/, "invalid id");
