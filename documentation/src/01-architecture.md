# 1. Architecture

## 1.1 The three applications

| Application | Repository | Runs where | Role |
|---|---|---|---|
| **Backend** | `chat_backend` | Server, PM2 process `h-chat` on `127.0.0.1:12000` | REST API, Socket.IO real-time hub, background jobs, push notifications, TURN credentials |
| **Chat app** | `chat_app` | The user's browser (served from `/projects/chat_app/dist`) and the Android app (same code packaged with Capacitor) | Everything the user sees; **all encryption and decryption**; WebRTC calls |
| **Backoffice** | `chat_backoffice` | The administrator's browser (served from `/projects/chat_backoffice/dist`) | Approve accounts, categories and rules, groups, storage, chats metadata, settings, activity log |

The web app and the Android app are **the same React code**. Capacitor wraps it in an Android WebView and adds a
few native plugins (notifications, files, screenshots blocking, call audio routing, a call service).

## 1.2 Component diagram

```mermaid
flowchart TB
  subgraph Client["chat_app (React 19 + Vite + Tailwind 4)"]
    UI["Screens<br/>Contacts · Chat · Live · Group · Media · Calls · Settings"]
    E2E["lib/e2e.ts<br/>libsodium (WASM)<br/>keys · encrypt · decrypt · sign"]
    CALLS["lib/calls.ts<br/>WebRTC engine<br/>1:1 + group mesh"]
    LIVE["lib/live.ts<br/>Socket.IO client"]
    NAT["Android plugins<br/>Push · LocalNotifications · Filesystem<br/>SecureScreen · CallAudio · CallService · Folders"]
    UI --> E2E
    UI --> CALLS
    UI --> LIVE
    UI --> NAT
  end

  subgraph Backend["chat_backend (Node 24 · Express 5 · Socket.IO)"]
    REST["REST routes<br/>auth · contacts · chats · live · files<br/>exports · groups · calls · notify · admin"]
    RT["realtime/index.ts<br/>Socket.IO: presence, typing, live relay,<br/>call signalling, flood guard"]
    BUS["lib/events.ts<br/>in-process event bus"]
    JOBS["jobs/cleanup.ts<br/>every minute: expire chats, live, files, exports"]
    PUSH["notify/<br/>Web Push (VAPID) · Firebase (FCM v1)"]
    REST --> BUS --> RT
    JOBS --> BUS
    REST --> PUSH
  end

  subgraph Data["Storage (same server)"]
    MDB[("MongoDB 8<br/>users, sessions, friendships, chats,<br/>messages, groups, files metadata, logs")]
    MEDIA[("/var/lib/h-chat/media<br/>encrypted file pieces")]
  end

  subgraph BO["chat_backoffice (React)"]
    PAGES["Dashboard · Users · Chats · Groups · Storage<br/>Categories · Activity log · Settings"]
  end

  LIVE <-- "WSS /socket.io" --> RT
  UI -- "HTTPS /api/*" --> REST
  PAGES -- "HTTPS /api/admin/*" --> REST
  REST --> MDB
  REST --> MEDIA
  CALLS <-. "DTLS-SRTP media" .-> TURN["coturn (TURN/STUN)"]
```

## 1.3 Deployment view

```mermaid
flowchart LR
  U1["User (web)"] -->|HTTPS 443| CF["Cloudflare proxy"]
  U2["User (Android)"] -->|HTTPS 443| CF
  ADM["Administrator"] -->|HTTPS 443| CF
  CF -->|"HTTPS 443<br/>(only Cloudflare IPs accepted)"| NG

  subgraph VPS["Contabo VPS · 37.60.240.195 · Ubuntu 24.04"]
    NG["nginx 1.24<br/>gates (access codes) · TLS · CSP<br/>static: chat_app/dist, chat_backoffice/dist<br/>/download → APKs"]
    NG -->|"127.0.0.1:12000<br/>/api, /socket.io"| H["PM2: h-chat<br/>(Node 24)"]
    H -->|127.0.0.1:27017| M[("MongoDB 8<br/>auth enabled")]
    H --> D[("/var/lib/h-chat/media")]
    TS["coturn 4.6<br/>UDP/TCP 3478 · TLS 5349<br/>relay UDP 49160–50159"]
  end

  U1 <-.->|"calls: STUN/TURN<br/>(not through Cloudflare)"| TS
  U2 <-.-> TS
  U1 <-.->|"calls: direct peer-to-peer<br/>when the networks allow it"| U2
```

Notes:

- **Cloudflare** proxies only the web traffic (chat and backoffice). Calls never go through Cloudflare: the TURN
  server is reached directly on its own ports.
- **nginx gates**: chat.omranisystems.com and adminchat.omranisystems.com first ask for an access code
  (shared `omranisystems` gate service); the Android app talks to `/api` directly with its own session token.
- The backend and MongoDB listen **only on 127.0.0.1**: they can't be reached from the internet.

## 1.4 Data model (MongoDB collections)

```mermaid
erDiagram
  USER ||--o{ SESSION : "signs in with"
  USER ||--o{ FRIENDSHIP : "is in"
  USER }o--o{ CATEGORY : "belongs to"
  FRIENDSHIP }o--|| CATEGORY : "uses rules of"
  CHAT ||--o{ MESSAGE : "holds (ciphertext)"
  CHAT ||--o{ FILE : "holds (metadata)"
  CHAT ||--o{ EXPORTREQUEST : "may have"
  GROUP ||--o{ GROUPMESSAGE : "holds (ciphertext + wraps)"
  GROUP ||--o{ FILE : "holds (metadata)"
  GROUP }o--|| CATEGORY : "uses rules of"
  USER ||--o{ LIVESESSION : "takes part in"
  USER ||--o{ CALL : "takes part in"
  USER ||--o{ PUSHSUBSCRIPTION : "browser push"
  USER ||--o{ FCMTOKEN : "Android push"
  USER ||--o{ ADMINLOG : "admin actions"
```

| Collection | Holds | Content readable by the server? |
|---|---|---|
| `users` | username, email, Argon2id password and passcode hashes, status, categories, public identity key, preferences | n/a (account data) |
| `sessions` | one active session per account, device info | n/a |
| `friendships`, `invites`, `blocks` | the contact graph | n/a |
| `categories`, `settings` | rules (modes, retention, files, export, calls), minimum app version | n/a |
| `chats` | participants, mode, retention, **public** chat keys, status, counters | no secrets |
| `messages` | **ciphertext**, nonce, key versions, receipts, expiry | **No** — XChaCha20-Poly1305 ciphertext |
| `groups`, `groupmessages` | members, **public** group keys; per message: ciphertext + the message key wrapped for each member | **No** |
| `files` | kind, size, pieces, expiry, status (name and key are inside the encrypted message) | **No** (pieces on disk are encrypted) |
| `livesessions` | who, when, how long, end reason | Nothing typed is ever stored |
| `calls` | who, when, kind, end reason | Audio/video never reach the server's application |
| `exportrequests` | who asked, answer, dates | The zip is built on the phone |
| `adminlogs`, `deviceevents` | audit trails (90 days) | n/a |

Expiry is enforced by MongoDB TTL indexes (`expiresAt`, `purgeAt`) and by the per-minute cleanup job.

## 1.5 Code layout

```
chat_backend/src
  app.ts                 Express app: helmet, CORS, rate limits, routers
  server.ts              start-up, migrations, Socket.IO, jobs
  realtime/              Socket.IO hub + presence
  modules/
    auth/ contacts/ chats/ live/ files/ exports/ groups/ calls/ notify/ me/
    admin/               backoffice API: routes.ts mounts one file per section
                         (users, contacts, chats, groups, storage, live, categories, logs, settings) + context.ts
    docs/                serves this documentation behind its access code
  models/                Mongoose schemas
  jobs/cleanup.ts        expiry every minute (files hourly)
  docs/                  MILESTONES.txt, SECURITY_REVIEW.md, TROUBLESHOOTING.md
chat_backend/documentation
  src/*.md               this documentation (Markdown + Mermaid)
  build.mjs              renders it to site/ (static HTML, diagrams as SVG)

chat_app/src
  app/App.tsx            screens, socket connection, notifications, routing
  lib/e2e.ts             all cryptography (libsodium)
  lib/calls.ts           WebRTC engine (1:1 + group mesh)
  lib/files.ts           encrypted upload/download in pieces
  lib/groups.ts          group keys and recipients
  pages/ components/     UI
chat_app/android/app/src/main/java/com/omranisystems/hchat/
  MainActivity, SecureScreenPlugin, FoldersPlugin, CallAudioPlugin, CallService

chat_backoffice/src/pages
  Dashboard Users UserDetails Chats LiveSessions Groups Storage Categories Logs Settings
```
