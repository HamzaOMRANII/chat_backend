# 9. API and events reference

Base URL: `https://chat.omranisystems.com/api` (users) · `https://adminchat.omranisystems.com/api/admin` (backoffice).
Authentication: web = `httpOnly` cookie; Android = `Authorization: Bearer <token>` + `X-Client: android`.
All bodies are JSON (except file pieces: `application/octet-stream`). Errors: `{ error, code, details? }`.

## 9.1 REST — users

| Area | Method | Path | Purpose |
|---|---|---|---|
| Public | GET | `/health` | Liveness |
| Public | GET | `/app/config` | `{ minAppVersion }` for the Android app |
| Auth | POST | `/auth/signup` | Request an account (pending approval) |
| Auth | POST | `/auth/login` | Password step → email code challenge |
| Auth | POST | `/auth/verify-code` · `/auth/verify-secure-code` · `/auth/verify-passcode` | Second step (email code, the user's secure code, or recovery passcode) → session |
| Auth | POST | `/auth/reset-credentials` · `/auth/admin-reset` | New password/passcode (after passcode or admin reset code) |
| Auth | GET | `/auth/me` · `/auth/socket-ticket` | Current user · 60-s Socket.IO ticket (web) |
| Auth | POST | `/auth/logout` | End the session |
| Me | GET | `/me/security-log` | The user's sign-in history |
| Me | POST | `/me/email` · `/me/email/verify` | Change email (code to the new address) |
| Me | GET / PUT / DELETE | `/me/secure-code` | Secure code state · set it (password + code) · remove it (password) |
| Calls | GET / PUT | `/me/calls` | "Receive calls" setting |
| Calls | GET | `/calls/turn` | 1-hour TURN credentials |
| Calls | POST | `/calls/diag` | Call audio numbers (diagnostics) |
| Contacts | GET | `/contacts` · `/contacts/:userId` · `/contacts/me` | List, one contact, my ID |
| Contacts | POST | `/contacts/invite` · `/contacts/add` · `/contacts/me/new-id` | Invite code, add by code/ID, new personal ID |
| Contacts | POST | `/contacts/requests/:id/accept` · `…/decline` | Answer a request |
| Contacts | POST / DELETE | `/contacts/:userId/block` · `/contacts/:userId` · `/contacts/invite` | Block, remove, cancel invite |
| Keys | PUT | `/keys/identity` | Publish this device's identity public key |
| Chats | GET | `/chats` · `/chats/:id` · `/chats/options/:userId` | Open chats, one chat, allowed modes with a contact |
| Chats | POST | `/chats` · `/chats/:id/accept` · `/chats/:id/decline` · `/chats/:id/keys` | Start, accept, decline, new device key |
| Chats | DELETE | `/chats/:id` | End a chat (deletes everything) |
| Messages | GET / POST | `/chats/:id/messages` | Read (ciphertext) / send (ciphertext, optional `fileId`) |
| Messages | POST | `/chats/:id/receipts` | Delivered / read |
| Live | GET / POST | `/live` | Open live chats / invite |
| Live | POST / DELETE | `/live/:id/accept` · `/live/:id/decline` · `/live/:id` | Accept, decline, leave |
| Files | POST | `/chats/:id/files` · `/groups/:id/files` | Start an upload (kind, size) |
| Files | PUT / GET | `/files/:id/chunks/:n` | Upload / download one encrypted piece |
| Files | GET | `/chats/:id/files` · `/groups/:id/files` · `/media` | File status lists, my space and requests |
| Files | POST | `/files/delete` | Delete files (for everyone) |
| Exports | GET / POST | `/chats/:id/exports` | List / request an export |
| Exports | POST / DELETE | `/exports/:id/approve` · `…/refuse` · `…/downloaded` · `/exports/:id` | Answer, record, cancel |
| Groups | GET | `/groups` · `/groups/:id` · `/groups/:id/messages` | My groups and requests, one group, messages (only my wraps) |
| Groups | POST | `/groups/:id/keys` · `/groups/:id/messages` · `/groups/:id/read` · `/groups/:id/leave` | Key, send, read, leave |
| Groups | POST / DELETE | `/groups/requests` · `/groups/requests/:id` | Ask the admin for a group / cancel |
| Notifications | GET / PUT | `/notifications` | Preferences, Web Push key |
| Notifications | POST / DELETE | `/notifications/push` · `/notifications/fcm` | Register browser / Android push |
| Notifications | POST | `/notifications/fcm-status` | Firebase registration diagnostics |

## 9.2 REST — backoffice (`/api/admin`)

| Area | Routes |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/verify-code`, `POST /auth/logout`, `GET /auth/me` |
| Dashboard | `GET /dashboard` |
| Users | `GET /users`, `GET /users/:id`, `GET /users/:id/contacts`, `POST /users/:id/approve · reject · suspend · reactivate · unlock · force-logout · reset-access`, `PUT /users/:id/categories`, `PUT /users/:id/secure-code {allowed}`, `DELETE /users/:id`, `DELETE /users/:id/chats` |
| Contacts | `PUT /friendships/:id/category`, `DELETE /friendships/:id` |
| Categories | `GET /categories`, `POST /categories`, `POST /categories/reorder`, `GET /categories/:id/members`, `DELETE /categories/:id` |
| Chats | `GET /chats`, `GET /chats/:id`, `DELETE /chats/:id`, `POST /chats/purge` |
| Live | `GET /live`, `DELETE /live/:id` |
| Groups | `GET /groups`, `POST /groups`, `PUT /groups/:id` (edit or approve), `POST /groups/:id/refuse`, `DELETE /groups/:id` |
| Storage | `GET /storage`, `GET /storage/users/:id`, `POST /storage/users/:id/request`, `DELETE /storage/users/:id/request`, `POST /storage/delete`, `POST /storage/cleanup` |
| Settings | `GET /settings`, `PUT /settings`, `GET /backup`, `POST /restore` |
| Log | `GET /logs?action=&admin=&q=&before=` |

Each row is one file in `chat_backend/src/modules/admin/` (`auth.ts`, `dashboard.ts`, `users.ts`, …).

## 9.2b Documentation (`/documentation`, HTML)

| Method | Path | Purpose |
|---|---|---|
| GET | `/documentation/…` | This site (static pages from `documentation/site`); without the docs cookie: the access-code page |
| POST | `/documentation/unlock` | Form `code=` → 12-hour `hc_docs` cookie (path `/documentation`, httpOnly, SameSite=Strict); 8 tries / 15 min per address |
| POST | `/documentation/lock` | Forget the cookie |

## 9.3 Socket.IO (`/socket.io`, WebSocket)

Rooms: `user:<userId>` (all of a user's apps) and `session:<sessionId>`.

**Client → server**

| Event | Payload | Purpose |
|---|---|---|
| `visibility` | `{ visible }` | App on screen or not (decides push vs banner) |
| `alive` | — (ack) | Connection check when the app comes back on screen |
| `typing` | `{ chatId }` | "is typing…" in a stored chat |
| `group:typing` | `{ groupId }` | Typing in a group |
| `live` | `{ sessionId, nonce, ct }` | Encrypted live-chat keystroke / file piece (relayed, never stored) |
| `call:start` | `{ to, kind }` or `{ groupId, kind }` (ack) | Ring a contact or a group |
| `call:answer` | `{ callId }` (ack) | Answer a 1:1 call |
| `call:join` | `{ callId }` (ack: who is already in) | Join a group call |
| `call:signal` | `{ callId, to, data: { sdp+sig \| candidate } }` | WebRTC signalling |
| `call:leave` | `{ callId, everyone? }` | Hang up / leave / end for everyone (starter only) |

**Server → client**

| Event | Meaning |
|---|---|
| `notify` | A notification to show (banner or phone notification) |
| `msg:new`, `msg:status`, `typing` | Stored chat: new message, receipts, typing |
| `chats:changed`, `chat:accepted`, `chat:ended`, `chat:keys` | Chat list and keys changed |
| `live`, `live:peer`, `live:accepted`, `live:changed`, `live:ended` | Live chat |
| `files:deleted`, `media:request`, `exports:changed` | Files and exports |
| `group:msg`, `group:read`, `group:typing`, `group:changed`, `group:call` | Groups |
| `call:incoming`, `call:answered`, `call:joined`, `call:left`, `call:signal`, `call:ended` | Calls |
| `contacts:changed` | Contacts or presence changed |
| `session:revoked` | This session was ended (signed in elsewhere, suspended…) |
