# 13. Developer guide

Everything a developer needs to fix a bug or add a feature without help. Each repository's `README.md` has the
same information in short form.

## 13.1 Set up

| Need | Version |
|---|---|
| Node.js | 24 (the server has 24.22) |
| MongoDB | 8, with a test user for the backend tests (see `chat_backend/tests/helpers.ts`) |
| For the APK only | Java 21, Android SDK in `/opt/android-sdk`, the signing key in `/root/.chat-keystore/` |

```bash
git clone git@github.com:HamzaOMRANII/chat_backend.git    # and chat_app, chat_backoffice
cd chat_backend && cp .env.example .env && npm ci && npm run dev     # API on 127.0.0.1:12000
cd ../chat_app && npm ci && npm run dev                              # web app, proxies /api to 12000
cd ../chat_backoffice && npm ci && npm run dev                       # backoffice, proxies /api/admin
cd ../chat_backend && npm run create-admin                           # once: a backoffice administrator
```

## 13.2 The same commands in every repository

| Command | What it does |
|---|---|
| `npm run dev` | Run with live reload |
| `npm test` | All tests (Vitest) |
| `npm run lint` | Code checker (Biome): house style and likely bugs; warnings are improvements, errors must be fixed |
| `npm run format` | Rewrites files in the house style (2 spaces, double quotes, semicolons, 160 columns) |
| `npm run typecheck` | TypeScript (strict) |
| **`npm run check`** | lint + typecheck + tests: **must pass before every commit** |
| `npm run build` | Production build |
| `npm run release` (chat_app) | Tests, version bump, web build and signed APK, published |

## 13.3 Code map: "where is…?"

| I want to change… | Look in |
|---|---|
| A screen of the app | `chat_app/src/pages/<Name>Page.tsx` (search for the visible title) |
| A reusable piece (button, field, sheet, message bar `Composer`, `UploadBubble`) | `chat_app/src/components/`; hooks (`useUploads`, `useMediaQuery`) in `chat_app/src/hooks/` |
| Which screens load on demand | `chat_app/src/app/App.tsx` (`lazy(() => import(...))`) |
| Colours, fonts | `chat_app/src/styles.css` (`@theme` tokens) |
| Encryption | `chat_app/src/lib/e2e.ts` (+ `e2e.test.ts`) |
| Calls | `chat_app/src/lib/calls.ts`, `components/CallScreen.tsx`, backend `modules/calls/` + `realtime/` |
| An API route | `chat_backend/src/modules/<feature>/routes.ts` (logic in `service.ts`) |
| Sign-in, sessions, locks, secure code | `chat_backend/src/modules/auth/routes.ts`, `sessions.ts` |
| A backoffice action | `chat_backend/src/modules/admin/<section>.ts` + `chat_backoffice/src/pages/<Section>Page.tsx` |
| A database field | `chat_backend/src/models/<model>.ts` |
| Real-time events | `chat_backend/src/realtime/index.ts`, `lib/events.ts` (bus) |
| Expiry and cleanup | `chat_backend/src/jobs/cleanup.ts` + TTL indexes in the models |
| Emails | `chat_backend/src/lib/mailer.ts` |
| Settings from `.env` | `chat_backend/src/config/env.ts` (validated at start) |
| Android-only behaviour | `chat_app/src/lib/native.ts`, `platform.ts`, `chat_app/android/app/src/main/java/…` |

## 13.4 Conventions

- **TypeScript strict** everywhere; validate every request body and query with **zod** (`parse(schema, data)`).
- **Errors:** throw `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `locked` from
  `lib/errors.ts`. They become `{ error, code, details }`. Write `error` for people (the app shows it as-is),
  and `code` for programs (`wrong_secure_code`, `challenge_expired`, …).
- **Secrets:** Argon2id (`hashSecret` / `verifySecret`) for anything a person chooses; SHA-256 only for
  short-lived random codes. Never log or return them; `select: false` on the schema.
- **Comments** explain *why* (rules, limits, surprises), not what the next line does.
- **Names:** React hooks start with `use`, nothing else does (the call methods are `selectMic`, `selectOutput`, …).
- **Commits:** one subject line saying what changed, a body saying why. Each milestone on a branch
  `mNN-<name>`, merged to `main` with `--no-ff` after approval, tagged `vX.Y.Z`.

## 13.5 Testing

| Repository | How | Example |
|---|---|---|
| chat_backend | Supertest against the real app and a **real MongoDB test database** (dropped between tests). Helpers: `makeApp()`, `approvedUser()`, `signIn()`, `adminAgent()`; `mail.sent` / `mail.alerts` capture emails | `tests/secureCode.test.ts` |
| chat_app | The whole `<App />` in jsdom with a fake server (`routes["/api/…"] = () => [status, body]`) and a fake socket; libsodium is replaced by a transparent stand-in (real crypto is tested in `lib/e2e.test.ts`) | `src/app/App.test.tsx` |
| chat_backoffice | Same approach, routes keyed by `"METHOD /api/admin/…"` | `src/app/App.test.tsx` |
| Browser | `npx tsx tests/e2e/server.ts 4790` in chat_backend: real API on the test database, fake mailer (`/__codes`), the built app; drive it with Playwright | the screenshots in [UX and UI](10-ux-ui.md) |

Rules: one backend test run at a time (a lock file enforces it). In UI tests use `await screen.findBy…` for
anything that appears after a request: `getBy…` there makes the test fail at random on a busy machine.

## 13.6 How to add a feature (worked example: the secure code, 1.1.0)

1. **Model:** fields on `User` (`secureCodeHash` with `select: false`, `secureCodeSetAt`, `secureCodeDisabled`),
   removed in `toJSON`; new security-log types in `deviceEvent.ts`.
2. **Validation:** `secureCodeSchema` in `lib/validate.ts`.
3. **Routes:** `POST /auth/verify-secure-code` (re-uses the login challenge, lock and session helpers),
   `GET/PUT/DELETE /me/secure-code` (password required), `PUT /admin/users/:id/secure-code`.
4. **Email:** `sendSecureCodeAlert` in `lib/mailer.ts` (and in the fake mailer in `tests/helpers.ts`).
5. **Backend tests:** `tests/secureCode.test.ts` covers set, remove, sign-in, wrong codes, lock, admin switch, reset.
6. **App:** `CodePage.tsx` (5 taps reveal the field), `components/SecureCodeSettings.tsx` in Settings, labels in
   `SecurityLogPage.tsx`, a test in `App.test.tsx`.
7. **Backoffice:** panel on `UserDetailsPage.tsx`, labels in `lib/format.ts`.
8. `npm run check` in all three, commit on the milestone branch, deploy, test on a phone, merge, tag.

## 13.7 Updating this documentation

The site you are reading is built from Markdown:

```
chat_backend/documentation/
  src/*.md          the chapters (Markdown + Mermaid diagrams); src/images/*.png screenshots
  build.mjs         renders src → site/ (one HTML page per chapter, diagrams pre-rendered to SVG)
  site/             the built site, committed, served at /documentation by the backend
```

```bash
cd chat_backend/documentation
npm ci                 # once: marked, mermaid, playwright (headless Chromium renders the diagrams)
npm run build          # writes site/
```

Then commit `src/` and `site/` together and restart the backend (`bash /projects/hchat-deploy.sh`).
The access code is stored only as an Argon2id hash in `chat_backend/.env` (`DOCS_CODE_HASH`). To change it:
`node -e "require('argon2').hash(process.argv[1]).then(console.log)" <new code>` (from `chat_backend`), put the
result in `.env`, restart.

## 13.8 Releasing

```bash
bash /projects/hchat-deploy.sh          # bug fix:   x.y.Z+1 (server + backoffice + web + APK)
bash /projects/hchat-deploy.sh minor    # milestone: x.Y+1.0
```

Every user-visible change ships to the web **and** the APK together. Phones show "Update available"; raise the
minimum version in the backoffice only when old apps must stop working.
