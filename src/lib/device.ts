import type { Request } from "express";
import Bowser from "bowser";
import { z } from "zod";

/** What the app reports about the device it runs on (sent with sign-up and sign-in). */
export const clientDeviceSchema = z
  .object({
    deviceId: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
    name: z.string().trim().max(80).optional(),
    platform: z.enum(["web", "android"]).default("web"),
    model: z.string().trim().max(80).optional(),
    manufacturer: z.string().trim().max(80).optional(),
    osVersion: z.string().trim().max(40).optional(),
    appVersion: z.string().trim().max(20).optional(),
    network: z.string().trim().max(20).optional(),
    screen: z.string().trim().max(20).optional(),
    language: z.string().trim().max(20).optional(),
    timezone: z.string().trim().max(60).optional(),
  })
  .strict();

export type ClientDevice = z.infer<typeof clientDeviceSchema>;

export type DeviceSnapshot = ClientDevice & {
  name: string;
  ip: string;
  country?: string;
  city?: string;
  browser?: string;
  os?: string;
  deviceType?: string;
};

/**
 * Device + network details recorded for the security log. Location comes from Cloudflare's
 * visitor headers (CF-IPCountry always; CF-IPCity only when "Add visitor location headers" is on).
 */
export function deviceSnapshot(req: Request, client: ClientDevice): DeviceSnapshot {
  // Bowser refuses an empty string; a missing user agent simply yields unknown values
  const ua = Bowser.parse(req.get("user-agent") || "unknown");
  const browser = ua.browser.name;
  const os = [ua.os.name, ua.os.versionName ?? ua.os.version].filter(Boolean).join(" ") || undefined;
  const fallbackName =
    client.platform === "android"
      ? [client.manufacturer, client.model].filter(Boolean).join(" ") || "Android phone"
      : `${browser ?? "Browser"} on ${ua.os.name ?? "unknown system"}`;
  const country = req.get("cf-ipcountry");
  const city = req.get("cf-ipcity");
  return {
    ...client,
    name: client.name || fallbackName,
    ip: req.ip ?? "unknown",
    country: country && country !== "XX" ? country : undefined,
    city: city ? decodeURIComponent(city) : undefined,
    browser,
    os,
    deviceType: ua.platform.type,
  };
}
