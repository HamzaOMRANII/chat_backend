import "dotenv/config";
import { z } from "zod";

const secret = z.string().min(32, "must be at least 32 characters");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(12000),

  MONGO_URI: z.string().startsWith("mongodb"),

  // Browser origins allowed to call the API (CORS + Socket.IO)
  APP_ORIGIN: z.url().default("https://chat.omranisystems.com"),
  ADMIN_ORIGIN: z.url().default("https://adminchat.omranisystems.com"),
  // Origin of the Android app's web view (Capacitor serves the bundled app from https://localhost)
  NATIVE_APP_ORIGIN: z.url().default("https://localhost"),

  // Session signing keys: one for users, one for the backoffice
  JWT_SECRET: secret,
  ADMIN_JWT_SECRET: secret,

  // Login codes are sent with the same SMTP account as the password manager
  EMAIL_HOST: z.string().min(1),
  EMAIL_PORT: z.coerce.number().int().positive(),
  EMAIL_FROM: z.string().min(1),
  EMAIL_PASSWORD: z.string().min(1),

  // coturn shared secret (use-auth-secret) and the relay addresses handed to clients
  TURN_SECRET: secret,
  TURN_URLS: z
    .string()
    .default("turn:turn.omranisystems.com:3478?transport=udp,turn:turn.omranisystems.com:3478?transport=tcp,turns:turn.omranisystems.com:5349?transport=tcp")
    .transform((s) =>
      s
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ),

  // Web Push (browser notifications). Without the keys, notifications only reach open apps.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@omranisystems.com"),

  // Firebase service account (Android notifications when the app is closed); missing file = off
  FIREBASE_SERVICE_ACCOUNT: z.string().default("/root/.hchat/firebase-service-account.json"),

  MEDIA_DIR: z.string().default("/var/lib/h-chat/media"),
  MOBILE_BUILDS_DIR: z.string().default("/projects/mobile_builds/h_chat"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration in .env:\n${problems}`);
  }
  return parsed.data;
}
