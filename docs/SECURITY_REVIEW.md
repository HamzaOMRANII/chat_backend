# H_CHAT security review — release 1.0 (2026-10-18)

Scope: chat_backend (API, Socket.IO, jobs), chat_app (web + Android), chat_backoffice, nginx and coturn on this server.

## What was checked, and the result

| Area | Check | Result |
|---|---|---|
| Dependencies | `npm audit` (production) in the 3 repos | 0 known vulnerabilities after updating fflate 0.8.2 → 0.8.3 (the advisory was in unzip, which H_CHAT doesn't use) |
| Sign-in | password + email code (or recovery passcode), one active session per account, revocation closes sockets | OK |
| Tokens | JWT HS256 only (`algorithms` pinned), separate user/admin secrets, socket tickets valid 60 s and refused elsewhere | OK |
| Cookies | `httpOnly`, `secure`, `sameSite=strict`; Android uses a bearer token instead | OK |
| Access control | every backoffice route except login/code requires an admin session; user routes check membership (chat participants, group members, file sender/recipient/group) | OK |
| Input | every body and query goes through zod; ids are ObjectIds; JSON limited to 64 KB; file pieces exact-size, 4 MB max | OK |
| Files on disk | paths built only from validated ids (no traversal); content encrypted on the device; deleted on expiry, chat end, admin request | OK |
| End-to-end encryption | libsodium: Ed25519 identities, X25519 chat/group keys signed by identity, XChaCha20-Poly1305 messages; group messages locked per member; files keyed per file; call offers/answers signed (DTLS fingerprint) | OK — the server never holds a private key |
| Groups | a message must be locked for every member with a key; removed/left members' keys are dropped, so they can't read anything new | OK (tested) |
| Calls | TURN credentials HMAC, 1 h, per user; signals relayed only between people in the call; group calls max 6 | OK |
| Notifications | Web Push payload and Firebase text are generic ("New message", "Incoming call"): no names or content to Google | OK |
| Errors | 500s return "Something went wrong" only; details stay in the server log | OK |
| Headers | helmet on the API; nginx CSP (`script-src 'self' 'wasm-unsafe-eval'`, `frame-ancestors 'none'`), nosniff, no-referrer leaks | OK |

## Changes made in this review

1. **Request limits** (were 300/min per address for everything): now **600/min per signed-in session** and **120/min per address** when not signed in, so a whole office behind one address isn't throttled together, and anonymous floods are cut sooner. Sign-in (30 per 15 min), sign-up (5 per hour), admin sign-in (20 per 15 min) and ID searches keep their own stricter limits.
2. **Socket flood guard**: about 200 events/s per connection (a live chat sending a file is the busiest real use); a connection that keeps going far beyond is disconnected and logged.
3. **Minimum app version**: the administrator can force old Android apps to update ("Update required") after a security fix.
4. fflate updated (see above).

## Known limits (by design, documented for the users)

- A browser can't block screenshots of view-only files (the Android app does, with FLAG_SECURE).
- When the Android app is fully closed, calls ring through a Firebase notification, not a full-screen ring over the lock screen.
- Firebase/Google sees that a notification was sent to a phone, and when; never by whom or what.
