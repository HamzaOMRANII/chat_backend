/**
 * Preview the documentation site as production serves it (access-code page, cookie, static pages),
 * with a throwaway code. For checking the site locally only.
 *   npx tsx tests/e2e/docs-preview.ts [port] [code]
 */
import { createServer } from "node:http";
import { createApp } from "../../src/app.js";
import { hashSecret } from "../../src/lib/secrets.js";
import { config, fakeMailer } from "../helpers.js";

const port = Number(process.argv[2] ?? 4791);
const code = process.argv[3] ?? "1234567890";
const app = createApp({ ...config, DOCS_CODE_HASH: await hashSecret(code) }, fakeMailer().mailer);
createServer(app).listen(port, "127.0.0.1", () => console.log(`docs preview on http://127.0.0.1:${port}/documentation/ (code ${code})`));
