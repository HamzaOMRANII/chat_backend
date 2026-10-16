import { pino } from "pino";

// Never log request bodies: they can hold passwords, codes or ciphertext.
export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
    remove: true,
  },
});
