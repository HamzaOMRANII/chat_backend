import { readFile } from "node:fs/promises";
import jwt from "jsonwebtoken";
import { logger } from "../../lib/logger.js";
import { FcmToken } from "../../models/fcmToken.js";

/**
 * Firebase Cloud Messaging (HTTP v1) for the Android app when it's closed. Google only ever gets a generic text
 * ("New message", "Incoming call"): never who wrote, never content. Tapping it opens the app, which shows the rest.
 */
type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };
let account: ServiceAccount | null = null;
let access: { token: string; until: number } | null = null;

export async function configureFcm(path: string | undefined) {
  account = null;
  if (!path) return false;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ServiceAccount;
    if (parsed.project_id && parsed.client_email && parsed.private_key) account = parsed;
  } catch {
    logger.warn("Firebase service account not readable: Android notifications only while the app runs");
  }
  return Boolean(account);
}
export const fcmReady = () => Boolean(account);

async function accessToken() {
  if (access && access.until > Date.now() + 60_000) return access.token;
  const tokenUri = account!.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = jwt.sign({ scope: "https://www.googleapis.com/auth/firebase.messaging" }, account!.private_key, {
    algorithm: "RS256",
    issuer: account!.client_email,
    audience: tokenUri,
    expiresIn: 3600,
  });
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Firebase auth failed (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  access = { token: data.access_token, until: Date.now() + data.expires_in * 1000 };
  return access.token;
}

/** What Google sees for each kind: nothing more than this. */
const GENERIC: Record<string, string> = {
  message: "New message",
  call: "Incoming call",
  chat_invite: "New chat invitation",
  live_invite: "Live chat invitation",
  contact_request: "New contact request",
  contact_added: "New contact",
  export_request: "Export request",
};

export async function sendFcm(sessionId: string, n: { kind: string; tag: string; url: string; body: string }) {
  if (!account) return;
  const tokens = await FcmToken.find({ sessionId }).lean();
  if (!tokens.length) return;
  const call = n.kind === "call" && n.body.startsWith("Incoming");
  const body = call ? "Incoming call" : (GENERIC[n.kind] ?? "New activity");
  const bearer = await accessToken();
  await Promise.all(
    tokens.map(async (t) => {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account!.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: t.token,
            data: { url: n.url, kind: n.kind },
            android: {
              priority: "high",
              // A ringing call is useless after 45 s
              ttl: call ? "45s" : "86400s",
              notification: { title: "H_CHAT", body, tag: n.tag, channel_id: call ? "hc_calls" : "hc_events", icon: "ic_stat_hchat", color: "#8C2A3F", sound: "default" },
            },
          },
        }),
      });
      if (res.ok) return;
      const err = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
      const code = err.error?.details?.find((d) => d.errorCode)?.errorCode ?? err.error?.status;
      // The app was uninstalled or the token replaced
      if (code === "UNREGISTERED" || code === "NOT_FOUND" || res.status === 404) await FcmToken.deleteOne({ _id: t._id });
      else logger.warn({ status: res.status, code }, "firebase send failed");
    }),
  );
}
