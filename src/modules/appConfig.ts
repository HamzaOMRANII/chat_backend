import { Router } from "express";
import { getSetting } from "../models/setting.js";

/** Public: what the Android app needs before anything else (the oldest version still allowed). */
export const appConfigRouter = Router().get("/", async (_req, res) => {
  res.set("Cache-Control", "no-store").json({ minAppVersion: await getSetting("minAppVersion", "0.0.0") });
});
