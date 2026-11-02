import { createHash } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import type { Config } from "../../config/env.js";
import { verifySecret } from "../../lib/secrets.js";

const COOKIE = "hc_docs";
const PATH = "/documentation";
const HOURS = 12;

/** The access-code page; `error` after a wrong code. Self-contained: no script, inline style only. */
const unlockPage = (
  error = "",
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>H_CHAT documentation</title>
<style>
:root{color-scheme:light dark;--bg:#0b0c11;--panel:#151722;--ink:#e8eaf0;--dim:#9ea3b5;--line:#2a2d3c;--accent:#c7707e;--brand:#8c2a3f}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fa;--panel:#fff;--ink:#1d2230;--dim:#5b6275;--line:#e3e6ee}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:28px}
.brand{font:700 18px ui-monospace,monospace;margin:0 0 18px}.brand span{color:var(--brand)}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 18px;color:var(--dim)}
label{display:block;font:11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin-bottom:7px}
input{width:100%;min-height:48px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--ink);font:22px ui-monospace,monospace;letter-spacing:.3em;padding:0 14px}
input:focus{outline:none;border-color:var(--accent)}
button{margin-top:16px;width:100%;min-height:50px;border:0;border-radius:14px;background:var(--brand);color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.err{margin:12px 0 0;color:#e5484d;font-size:13.5px}
</style></head><body><main>
<p class="brand">H<span>_</span>CHAT</p>
<h1>Technical documentation</h1>
<p>Enter the documentation access code.</p>
<form method="post" action="${PATH}/unlock">
<label for="code">Access code</label>
<input id="code" name="code" type="password" inputmode="numeric" autocomplete="off" required autofocus maxlength="40">
${error ? `<p class="err" role="alert">${error}</p>` : ""}
<button type="submit">Open the documentation</button>
</form></main></body></html>`;

/**
 * The technical documentation (static site in DOCS_DIR) behind its own access code, on top of the
 * omranisystems.com gate that nginx applies. A correct code gives a 12-hour cookie limited to /documentation.
 */
export function createDocsRouter(config: Config) {
  const router = Router();
  // Its own signing key: a docs cookie is never a valid session token, and the other way round
  const key = createHash("sha256").update(`${config.JWT_SECRET}:docs`).digest();
  const unlockLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 8,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).type("html").send(unlockPage("Too many tries. Wait 15 minutes."));
    },
  });

  const unlocked = (req: Request) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
    if (!token) return false;
    try {
      return (jwt.verify(token, key, { algorithms: ["HS256"] }) as { use?: string }).use === "docs";
    } catch {
      return false;
    }
  };
  const locked = (res: Response, status = 401, error = "") => {
    res.status(status).set("Cache-Control", "no-store").type("html").send(unlockPage(error));
  };

  router.post("/unlock", unlockLimiter, express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? "").trim();
    if (!config.DOCS_CODE_HASH || !(await verifySecret(config.DOCS_CODE_HASH, code))) return locked(res, 401, "Wrong access code.");
    const token = jwt.sign({ use: "docs" }, key, { algorithm: "HS256", expiresIn: HOURS * 3600 });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      path: PATH,
      maxAge: HOURS * 3600_000,
    });
    res.redirect(303, `${PATH}/`);
  });

  router.post("/lock", (_req, res) => {
    res.clearCookie(COOKIE, { path: PATH });
    res.redirect(303, `${PATH}/`);
  });

  router.use((req, res, next) => {
    // "/documentation" -> "/documentation/" so the pages' relative links resolve
    if (req.originalUrl === PATH) return res.redirect(301, `${PATH}/`);
    if (!config.DOCS_CODE_HASH) return res.status(404).type("text").send("Not found");
    if (!unlocked(req)) return locked(res);
    res.set("Cache-Control", "private, no-cache");
    next();
  });
  router.use(express.static(config.DOCS_DIR, { index: "index.html", extensions: ["html"], redirect: true }));
  router.use((_req, res) => {
    res.status(404).type("text").send("Not found");
  });
  return router;
}
