# H_CHAT backend

API and real-time server for H_CHAT (Node 24, TypeScript, Express 5, Socket.IO, MongoDB).
It serves the user app (`chat_app`) on `/api` + `/socket.io` and the backoffice (`chat_backoffice`) on `/api/admin`.
Full system documentation: `/projects/chat_documentation/` (architecture, encryption, flows, API reference).
When something breaks: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Start in 5 minutes

```bash
cp .env.example .env      # fill in the values (each one is explained in the file)
npm ci
npm run dev               # http://127.0.0.1:12000, restarts on every change
npm run check             # code checker + types + all tests: run before every commit
```

The tests need a local MongoDB with a test user (see `tests/helpers.ts` → `TEST_MONGO_URI`). They drop and
recreate the `h_chat_test` database, never the real one. Only one test run at a time (a lock enforces it).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Server with live reload |
| `npm test` | All tests (`vitest run`); one file: `npx vitest run tests/auth.test.ts` |
| `npm run lint` | Code checker (Biome): style + likely bugs |
| `npm run format` | Rewrites files in the house style (2 spaces, double quotes, 160 columns) |
| `npm run typecheck` | TypeScript only |
| `npm run check` | lint + typecheck + tests, what a change must pass |
| `npm run build` | Compiles to `dist/` (what production runs) |
| `npm run create-admin` | Creates a backoffice administrator |

## Where things live

```
src/
  server.ts            starts HTTP + Socket.IO + jobs (production entry: dist/server.js)
  app.ts               Express app: security headers, CORS, every router mounted under /api
  config/env.ts        every setting from .env, validated at start (a missing one stops the server)
  lib/                 small shared helpers: errors, validation (zod), hashing, mailer, device info, logger
  middleware/auth.ts   requireUser / requireAdmin: reads the session cookie or Bearer token
  models/              one Mongoose model per collection (user, chat, message, file, group, …)
  modules/<feature>/   routes.ts = HTTP routes, service.ts = the logic other modules reuse
    auth/              sign-up, sign-in (password → email code | secure code | recovery passcode), sessions
    me/                the signed-in user's own settings (security log, email, secure code)
    contacts/ chats/ live/ files/ exports/ groups/ calls/ notify/
    admin/             the backoffice API: routes.ts mounts one file per backoffice section
                       (users.ts, chats.ts, groups.ts, storage.ts, settings.ts, …); context.ts = shared helpers
  realtime/            Socket.IO: connection auth, presence, events pushed to the apps
  jobs/cleanup.ts      every minute: expire chats/live sessions/exports, delete expired files
tests/                 one test file per module, against a real MongoDB (supertest)
docs/                  DESIGN.md, MILESTONES.txt, SECURITY_REVIEW.md, TROUBLESHOOTING.md
```

## Common changes

**Add an API route.** Put it in the module's `routes.ts` (or a new `modules/<feature>/routes.ts` mounted in
`app.ts`). Validate the input with `parse(zodSchema, req.body)` from `lib/validate.ts`; throw the helpers from
`lib/errors.ts` (`badRequest`, `notFound`, …) and they become `{ error, code }` JSON answers. Guard with
`requireUser(config)`. Add a test in `tests/<module>.test.ts` (copy a neighbour: `makeApp()`, `approvedUser()`,
`signIn()` from `tests/helpers.ts`).

**Add a backoffice action.** Add the route to the right file in `src/modules/admin/`, guard it with `admin`,
and call `log(req, "thing.done", userId)` so it appears in the backoffice activity log.

**Add a security-log event.** Add the type to `DEVICE_EVENT_TYPES` in `models/deviceEvent.ts`, record it with
`recordEvent(...)`, and give it a label in `chat_app/src/pages/SecurityLogPage.tsx` and
`chat_backoffice/src/lib/format.ts`.

**Add a field to a model.** Add it to the schema in `models/`. MongoDB needs no migration: old documents
simply don't have the field, so give it a `default` or handle `undefined`. Secrets: `select: false` and remove
them in the `toJSON` transform (see `models/user.ts`).

## Rules

- Secrets only in `.env` (git-ignored) and `/root/ACCESS.txt`. Never in code, tests or commit messages.
- Message and file **content never reaches the server in clear**: it is encrypted on the devices. Don't add
  code that logs or stores request bodies of messages, files or live chats.
- Every change keeps `npm run check` green. Commit messages say what changed and why.

## Deploy (production)

The server runs under PM2 as `h-chat` (`/projects/ecosystem.config.js`) behind nginx:

| Address | Served by |
|---|---|
| `chat.omranisystems.com/api`, `/socket.io` | this server, not gated (the Android app has its own login) |
| `chat.omranisystems.com/download/` | `/projects/mobile_builds/h_chat` (APKs) |
| `adminchat.omranisystems.com/api/admin` | this server, behind the gate |

Put everything live (server, backoffice, web app + APK) with one command:

```bash
bash /projects/hchat-deploy.sh            # patch release (1.1.0 -> 1.1.1)
bash /projects/hchat-deploy.sh minor      # new milestone (1.1.x -> 1.2.0)
```

Server only: `npm run build && pm2 restart h-chat`. Logs: `pm2 logs h-chat`.

## Call relay (coturn)

`turn.omranisystems.com` (DNS only) runs coturn with `use-auth-secret`; `TURN_SECRET` here must equal
`static-auth-secret` in `/etc/turnserver.conf`. Ports: 3478 UDP/TCP, 5349 TLS, relay range 49160–49200 UDP.
Its Let's Encrypt certificate renews automatically (`/etc/letsencrypt/renewal-hooks/deploy/coturn.sh`).
`/usr/local/sbin/turn-egress.sh` stops the relay from opening new connections to this server's own services.
