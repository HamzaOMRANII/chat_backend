# H_CHAT — Design (v1, approved 2026-10-16)

Three repos:

- `chat_backend`: Node.js, Express 5, Socket.IO, MongoDB (Mongoose). Runs under PM2 on port 12000. Serves both the user API and the admin API.
- `chat_app`: React 19 + Vite app for users. **One codebase, two outputs:** the web app (static build served by this server) and an **Android APK** built from the same code with **Capacitor** (see §2.1). No iOS.
- `chat_backoffice`: React 19 + Vite web app for the admin (you), served as a separate static build on its own address. It talks only to `/api/admin/*`.

The stack matches the other apps on this server (gym, passwordManager, portfolio).

## 1. Principles

1. **Invite-only.** Anyone can sign up, but the account stays locked until the admin approves it in the backoffice.
2. **Nothing is permanent.** Every message and file has an expiry of 7 days or less. "Live" chats are never written to disk at all.
3. **End-to-end encrypted.** The server relays and stores only ciphertext. It cannot read messages or files, and it cannot listen to calls.
4. **No notifications.** No push and no email, except the login OTP. You only see messages while the app is open.
5. **Small disk footprint.** The server has 100 GB in total, so media is capped, has a short life, and is cleaned up aggressively.

## 2. Architecture

```
 ┌──────────────────┐
 │ chat_backoffice  │  HTTPS (REST, /api/admin/* only)
 │ React/Vite       │ ─────────────────────┐
 └──────────────────┘                      ▼
 ┌──────────────┐   HTTPS (REST)    ┌────────────────────────────┐
 │  chat_app    │ ────────────────▶ │  chat_backend (Express)    │
 │  React/Vite  │   WSS (Socket.IO) │  - auth / admin / friends  │
 │  libsodium   │ ◀──────────────▶  │  - chat relay (ciphertext) │
 │  WebRTC      │                   │  - media store (encrypted) │
 └──────┬───────┘                   │  - cleanup jobs            │
        │                           └──────┬──────────────┬──────┘
        │  WebRTC (DTLS-SRTP, P2P)         │              │
        │  voice / video / live files   MongoDB      /var/chat-media
        ▼                                  (TTL indexes)  (encrypted blobs)
 ┌──────────────┐
 │ other client │ ◀── via coturn (TURN relay) only when P2P is blocked;
 └──────────────┘     the relay forwards encrypted packets it cannot read
```

## 2.1 Android app (sideloaded APK, no store)
- **How:** Capacitor wraps the same React code into a native Android app. Native plugins give camera/microphone access for calls, file picking, secure key storage (Android Keystore) and better device information (§3.5).
- **Never published** to Google Play or any other store. Users download the APK from our server.
- **Builds:** at the end of each milestone (each build phase, or on request), I run `npm run build:apk` in `chat_app`. It increases the version, builds a **signed release APK**, and copies it to `/projects/mobile_builds/`:
  ```
  /projects/mobile_builds/
    chat-1.3.0.apk            ← each version (last 5 kept, older deleted)
    chat-latest.apk           ← copy of the newest
    latest.json               { version, versionCode, sha256, size, date, notes }
  ```
  APKs are **not committed to git** (large binaries).
- **Signing key:** one release keystore, created once, stored outside the repos (`/root/.chat-keystore/`) **and backed up**. Every update must be signed with the same key; if it is lost, every user has to uninstall and reinstall (losing their keys and stored chats).
- **Download:** served at `/download/chat-latest.apk`. The **login screen of the web app** shows "Download the Android app", the version, the SHA-256 fingerprint, and install instructions:
  1. Open the link on your Android phone and download the file.
  2. Open it. If Android asks, allow **"Install unknown apps"** for your browser (Settings → Apps → [browser] → Install unknown apps).
  3. If Play Protect warns "unknown app", tap **More details → Install anyway**.
  4. Open the app and log in. You can turn "Install unknown apps" off again afterwards.
- **Updates:** there is no store to update the app, so the app reads `latest.json` at start-up. If a newer version exists it shows "Update available" with a download button. The backend can set a **minimum version**; older apps are blocked until updated (needed when the API changes).
- **One device rule still applies:** the phone and the web app count as two devices. Logging in on the phone logs out the browser, and the other way round.
- **Server needs:** JDK 21 and the Android command-line SDK (about 4 GB of disk). Not installed yet.

## 3. Accounts and authentication

### 3.1 Sign up → approval
1. The user signs up with a username, an email, a password, and a **recovery passcode** (6–8 digits they must memorise). The passcode is hashed with argon2 like the password.
2. The account is created with `isApproved: false`. Login returns *"Waiting for approval"*.
3. The admin (you) sees pending accounts in the **backoffice** (`chat_backoffice`) and clicks Approve or Reject. The user can log in only after approval. The first admin is created with a seed script: `npm run create-admin`.

### 3.2 Login (always two steps)
| Step | Normal path | Lost-email path |
|---|---|---|
| 1 | username + password | username + password |
| 2 | 6-digit **OTP sent by email** (valid 5 min, 5 attempts) | **recovery passcode** |
| Result | full session | **one-time session** limited to "change password + new passcode (+ new email)" |

- The recovery passcode can be used **once**. After it is used, the user must set a new password and a new passcode before doing anything else (`mustReset: true`).
- The session is a JWT in an httpOnly, Secure, SameSite=Strict cookie, the same approach as passwordManager.
- Rate limits apply to login, OTP, and passcode. After repeated failures the account is temporarily locked.

### 3.3 Backoffice (`chat_backoffice`)
A separate web app, only for admins. It is never linked from `chat_app`.

- **Login:** admin username + password, then an email OTP. Admin accounts (`role: admin`) cannot log in to `chat_app`, and normal users cannot log in to the backoffice.
- **Session:** its own cookie (`admin_session`), shorter life (2 h), separate from the user cookie.
- **Dangerous actions** (delete account, delete chat history, delete group) ask for confirmation by typing the username or group name.

#### Dashboard
- Totals: users by status, users online now, active chats by mode, messages and files in the last 24 h, disk used vs. 100 GB.

#### Users list
- Every user, with search (username, email, personal ID) and filters (status, category, online, last connected).
- Columns: username, email, status, sign-up date, last connected, current device, online now, number of friends, open chats, storage used, **last message sent** (when, to whom, which mode).
- Bulk actions: approve, suspend.

#### User details page
- **Account:** username, email, status, role, **categories** (edit), personal ID, sign-up date, approval date and by whom, privacy notice accepted on, presence visibility, failed logins, locked until.
- **Devices:** every device ever used (name, type, browser, OS, screen, language, time zone, first seen, last seen, number of logins). The current one is marked.
- **Login history:** each login, logout, kick and failed attempt with IP, location, device and time.
- **Chats:** each chat this user is in: with whom, mode, retention, started, last message time, message count, files and their size, status (active / ended).
- **Last messages:** for each chat, the most recent messages: time, sender, type (text / file), size, delivered / read.
- **Friends and groups.**
- **Actions:**
  - **Approve** / **Reject** (pending accounts)
  - **Suspend** (blocks login, disconnects now) / **Reactivate**
  - **Force logout**
  - **Delete chat history:** one chat, or all of this user's chats. Purges messages and files for both participants, and the other person sees "This chat was deleted by the administrator".
  - **Delete account:** deletes the user, their friendships, chats, messages and files. Their security log is kept 90 days, then deleted.
  - **Reset login:** forces a new password and passcode at the next login.

#### Chats list
- All chats (one-to-one and groups): participants, mode, started, last activity, message count, storage. Actions: **Delete** (purge now).

#### Categories, Groups, Storage, Activity log
- **Categories:** create, rename, reorder, edit rules (§4.2), see and edit members.
- **Groups:** create groups, add or remove members, delete (see §5.3)
- **Storage:** disk used vs. 100 GB, media stored per user and per chat, the biggest files (size and owner only), and a button to run the cleanup job now.
- **Activity log:** every admin action (who, what, on whom, when), kept 90 days.

#### What the admin can and can't see
Messages, files and calls are end-to-end encrypted, so the backoffice shows **metadata only**: who, with whom, when, which mode, type and size. It **cannot show the text of messages, open files, or listen to calls**. The admin can still **delete** any of them. Live-mode chats are never stored, so for them only the start time, end time and duration are recorded.

### 3.4 One device per account
- Only **one active session** per account. Logging in on a new device ends the old session immediately: its socket is disconnected and its cookie no longer works.
- The new device creates new encryption keys. Stored chats from the old device can't be read on the new one (at most 7 days of history is lost).
- At login, the user sees: *"Last login: Chrome on Windows, Paris, 2 days ago. Not you? Change your password."*

### 3.5 Device and security information
Collected at every login and connection, so suspicious access can be spotted:

| Collected | How |
|---|---|
| Public IP address | from the request |
| Approximate location (country, city) | from the IP (offline GeoIP database) |
| Browser, OS, device type | from the browser (user agent / client hints) |
| Screen size, language, time zone | sent by the app |
| Device ID | random ID generated by the app on first login and kept in the browser |
| Device name | chosen by the user at first login (e.g. "My laptop"), default "Chrome on Windows" |
| Login time, logout time, failed attempts | server |

> **Web limit:** in a browser, the app **cannot** read the MAC address, the local/private IP, or the real device name. No browser exposes them.
>
> **Android app** collects more: phone manufacturer and model, the device name set in the phone, Android version, app version, network type (Wi-Fi / mobile), and a device ID stored in secure storage. **The MAC address is not available on Android either**: since Android 6, apps receive a fixed fake value (`02:00:00:00:00:00`).

- **User notice:** the sign-up form shows a short notice that this information, plus chat metadata (who, when, not content), is collected and visible to the administrator for account security (detecting hacking or account theft). Sign-up requires a checkbox to accept it. Settings has a **"My security log"** page showing the user their own records.
- Kept for **90 days**, then deleted automatically.
- The admin sees it in the backoffice (Security screen) and can suspend an account or force a logout.

## 4. Categories, friends and presence

### 4.1 Categories (admin only)
- The admin creates categories in the backoffice. Initial set: **Family, Friends, Externals, Secret, Pro, Confidential**. More can be added later.
- A user can be in **one or more** categories. The admin must pick at least one when approving an account. A user with no category can't add anyone.
- **Users never see categories.** No category name, badge or hint appears anywhere in `chat_app` or its API responses. Only the backoffice shows them.
- Two users can become friends only if they **share at least one category**. Each friendship belongs to **one** category: if they share several, the server picks the first shared one by the admin's category order (the user is never asked, since users can't see categories). The admin can change a friendship's category in the backoffice.
- **Removing a user from a category** immediately ends every friendship in that category and purges those chats and files. The other person sees "This contact is no longer available".

### 4.2 Rules per category
Each category has rules, editable in the backoffice. The app hides anything the friendship's category doesn't allow, and the server enforces it too.

| Category | Chat modes | Max retention | Files | Export | Calls |
|---|---|---|---|---|---|
| Family | Live, Keep-alive, Automatic | 7 days | ✓ | ✓ | voice + video |
| Friends | Live, Keep-alive, Automatic | 7 days | ✓ | ✓ | voice + video |
| Pro | Live, Keep-alive, Automatic | 7 days | ✓ | ✓ | voice + video |
| Externals | Keep-alive | 3 days | ✗ | ✗ | voice only |
| **Secret** | **Live only** — the chat is deleted as soon as either side leaves it | none (never stored) | P2P only | ✗ | voice + video |
| Confidential | Live, Keep-alive | 1 day | ✓ | ✗ | voice + video |

(Default values; the admin can change them.) If the admin tightens a rule, existing chats that break it are ended and purged.

### 4.3 Adding a friend (by ID only)
- **No search and no user directory.** The only way to add someone is with an ID they gave you outside the app.
- Two kinds of ID, both available:
  - **Personal ID:** random, like `K7QM-4XPA-9DTR`, not the username. Shown on the profile with Copy and a QR code. **Regenerate** makes the old one stop working.
  - **Invite code:** one-time, expires after 24 h, dead after one use. A user can have up to 5 open invite codes and cancel them.
- Entering an ID or code sends a **friend request**; the other person must accept.
- **One answer for every failure.** Wrong ID, expired code, or no shared category all return *"No user found with this ID"*, so nobody learns that an account exists or how it is categorised.
- **Anti-guessing:** 10 lookups per hour per user. Repeated failures appear in the backoffice (Security) and can lock the feature for that user.
- You can only chat with or call accepted friends.

### 4.4 Presence
- **Online status / last seen** comes from the socket connection. Each user can hide it (on by default).
- **Typing indicator** is used in the stored modes. In Live mode, the live text replaces it.

## 5. Chat modes

A chat is a session between two friends. The person who starts it picks the mode, and the other person sees the mode before accepting.

| Mode | Where messages live | How long | Both must be online? |
|---|---|---|---|
| **Live** | Only in the two browsers' memory. **Never stored on the server.** | Until the chat ends (either side leaves or closes) | Yes |
| **Keep-alive** | Encrypted in MongoDB | Chosen at start: **1–7 days** per message | No |
| **Automatic** | Encrypted in MongoDB | Fixed **7 days** per message | No |

(Automatic is Keep-alive fixed at 7 days. It is a separate one-click option in the UI.)

### 5.1 Live mode (keystroke streaming)
- Starting a Live chat works like a call: A invites, B accepts, and the session opens.
- While A types, A's client sends the encrypted **current draft** about every 50 ms (throttled). B sees the text appear and change as A types, including backspaces.
- Sending the full draft rather than single keys keeps the text correct even if a packet is lost or arrives out of order.
- When A presses **Enter**, the message is "committed": it turns solid on both sides and the draft is cleared.
- The server only relays. It writes nothing to the database or disk.
- When either side leaves, closes the tab, or drops for more than 30 s, the chat **ends** and both clients wipe it from memory.
- Files in Live mode go **directly peer-to-peer** (WebRTC data channel), so the server never stores them.

### 5.2 Keep-alive / Automatic
- Each message is stored as ciphertext with `expiresAt = sentAt + retention`. A MongoDB **TTL index** deletes it automatically.
- **Read receipts** show ✓ when delivered and ✓✓ when read.
- **End chat** button: either participant can end the chat, which **immediately purges** all messages and media for both sides.
- A chat with no messages left is removed automatically.

### 5.3 Groups (created by the admin only)
- Users can only chat one-to-one. **Only the admin** can create a group, from the backoffice.
- The admin picks a name, a **category**, the members, and the retention. All members must be in that category, and the group follows its rules (a Secret group would be Live-only, so v1 doesn't allow Secret groups). The admin can add or remove members at any time. Members can't add others.
- Group messages and files are end-to-end encrypted. Each member has a group key shared with the others over their encrypted channels. When a member is removed, the keys are replaced, so they can't read new messages.
- The admin can see a group's content only if they add themselves as a member.
- Group chats have typing indicator, read receipts and files. No Live mode, export, or calls in groups for v1 (group calls need a media server).
- Deleting a group purges all its messages and files.

## 6. Files and images
- Allowed in every mode: stored modes go through the server, Live mode is P2P.
- The file is **encrypted in the browser before upload**, so the server stores an opaque blob.
- Life on the server is **min(chat retention, 7 days)**, and it is deleted early when the chat ends.
- Limits (adjustable):
  - **100 MB per file** (uploaded in encrypted chunks, so a lost connection can resume)
  - **2 GB of live storage per user**
  - Uploads are refused if the disk is more than 80% full.
- An hourly cleanup job deletes expired blobs and orphan files (files with no database record, and database records with no file).

## 7. Export chat (needs the other side's approval)
1. A button at the top of the chat opens **Export** with two choices: *Messages + media* or *Media only*.
2. The other participant receives an approval request in the chat and taps Accept or Deny.
3. If they accept, the requester has **24 h** to download. Their browser fetches the encrypted data, decrypts it locally, and builds a **.zip**. The server never sees plaintext.
4. Export isn't available in Live mode, because nothing is stored.

> Honest limit: the approval stops the bulk download, but it cannot stop someone from taking screenshots of what is already on their screen.

## 8. Voice and video calls
- These use **WebRTC**. Audio and video are encrypted with DTLS-SRTP and normally travel peer-to-peer. Socket.IO is used only for signalling (offer, answer, ICE).
- **coturn** (self-hosted TURN) is used when a direct connection fails. It relays encrypted packets only and cannot decode them.
- To stop the server from secretly placing itself in the middle of a call, each side **signs its DTLS fingerprint with its identity key**, and the other side verifies the signature.
- Calls are available only between friends who are both online. There are no voice messages.

## 9. End-to-end encryption

The browser-side encryption uses the **libsodium** library.

- **Identity key.** Each device generates an Ed25519/X25519 identity key pair on first login. The private key stays in the browser (IndexedDB) and is never sent to the server. The server stores only the public key.
- **Per-chat keys.** At the start of each chat, both sides create **new ephemeral keys**, sign them with their identity keys, and exchange them. The shared chat key is derived from these keys, and messages and files are encrypted with XChaCha20-Poly1305.
- **What ending a chat does.** When a chat ends, the chat keys are deleted. Any leftover ciphertext can then never be decrypted, which gives forward secrecy per chat.
- **Safety code.** Each friend has a short **safety code** you can compare in person to confirm that no one is intercepting.
- **Honest limits:**
  - The server can still see **metadata**: who talks to whom, when, and how large messages are.
  - Because this is a web app, you trust the JavaScript your own server sends to the browser.

## 10. Data model (MongoDB)

```
User          { username, email, passwordHash, passcodeHash, isApproved,
                status: pending|approved|rejected|suspended, role: user|admin,
                mustReset, identityPubKey, showPresence, lastSeenAt, failedLogins, lockedUntil,
                activeSessionId, activeDeviceId, privacyAcceptedAt,
                categoryIds[], friendId (personal ID, unique), friendLookupFails[] }
Session       { userId, deviceId, createdAt, revokedAt, revokeReason }
DeviceEvent   { userId, deviceId, deviceName, type: login|logout|failed|connect|kicked,
                ip, country, city, browser, os, deviceType, screen, language, timezone, at }  TTL 90 days
Group         { name, memberIds[], createdBy(admin), retentionDays, keyVersion }
OtpCode       { userId, codeHash, attempts, expiresAt }            TTL
Category      { name, order, rules{ modes[], maxRetentionDays, files: all|p2p|none,
                export, calls: none|voice|video } }
Friendship    { requesterId, recipientId, categoryId, status: pending|accepted, createdAt }
InviteCode    { userId, codeHash, expiresAt, usedAt }               TTL
Chat          { participants[2] or groupId, mode: live|keep|auto, retentionDays (1–7),
                ephemeralPubKeys{}, status: pending|active|ended, createdBy, startedAt, endedAt,
                lastActivityAt, lastMessage{ senderId, at, kind, size }, messageCount, storageBytes,
                deletedByAdmin }
Message       { chatId, senderId, ciphertext, nonce, kind: text|file, attachmentId,
                deliveredAt, readAt, expiresAt }                   TTL   (stored modes only)
Attachment    { chatId, uploaderId, path, size, mime(enc), expiresAt }  TTL + file cleanup
ExportRequest { chatId, requesterId, scope: all|media, status, expiresAt }  TTL
AdminLog      { adminId, action, targetUserId, at }                TTL 90 days
```

## 11. API outline

**REST**
- Auth: `/api/auth/signup`, `/login`, `/verify-otp`, `/verify-passcode`, `/reset-credentials`, `/logout`, `/me`, `/security-log`
- Admin (backoffice only, `admin_session` cookie):
  - `/api/admin/auth/login`, `/verify-otp`, `/logout`, `/me`
  - `GET /api/admin/dashboard`
  - `GET /api/admin/users?status=&q=&online=&sort=` (list with last message, device, storage)
  - `GET /api/admin/users/:id` (full details), `PATCH /api/admin/users/:id` (approve, reject, suspend, reactivate, reset login), `DELETE /api/admin/users/:id`
  - `GET /api/admin/users/:id/chats`, `DELETE /api/admin/users/:id/chats` (delete all their chat history)
  - `GET /api/admin/chats`, `GET /api/admin/chats/:id/messages` (metadata only), `DELETE /api/admin/chats/:id`
  - `GET /api/admin/users/:id/devices`, `POST /api/admin/users/:id/logout`
  - `/api/admin/categories` (create, rename, reorder, edit rules, delete)
  - `PUT /api/admin/users/:id/categories`, `PATCH /api/admin/friendships/:id` (change category)
  - `/api/admin/groups` (create, rename, add/remove members, delete)
  - `GET /api/admin/storage`, `POST /api/admin/storage/cleanup`
  - `GET /api/admin/logs`
- Friends: `/api/friends`, `/api/friends/requests`, `POST /api/friends/request` (body: personal ID or invite code), `PATCH /api/friends/requests/:id` (accept/decline), `DELETE /api/friends/:id`
- My ID: `GET /api/me/friend-id`, `POST /api/me/friend-id/regenerate`, `/api/me/invites` (create, list, cancel)
- Chats: `/api/chats`, `POST /api/chats` (mode, retention), `DELETE /api/chats/:id` (end + purge)
- Media: `POST /api/chats/:id/attachments`, `GET /api/attachments/:id`
- Export: `POST /api/chats/:id/export`, `PATCH /api/exports/:id`, `GET /api/exports/:id/bundle`

**Socket.IO events**
- Presence: `presence:update`
- Typing: `typing:start|stop`
- Live chat:
  - `live:invite|accept|decline`
  - `live:draft` (encrypted draft)
  - `live:commit`
  - `live:end`
- Stored chats: `msg:new`, `msg:delivered`, `msg:read`, `chat:ended`
- Export: `export:request|answer`
- Calls:
  - `call:invite|accept|decline|end`
  - `rtc:offer|answer|ice`

## 12. Screens (chat_app)
1. Sign up → "Waiting for approval"
2. Login → OTP / "Lost access to email? Use passcode" → forced reset screen
3. **Home:** friends list with online dots and last seen, pending requests, and an **Add friend** button (enter an ID or invite code, or scan a QR code)
4. **My ID:** personal ID with Copy / QR / Regenerate, and invite codes (create, share, cancel)
5. **Start chat** dialog: only the modes and retention the category allows (Live / Keep-alive / Automatic)
6. **Chat:**
   - Header: friend, mode badge, time left, Export, Voice call, Video call, End chat
   - Message list
   - Input with file attach
7. **Call** screen: voice or video, mute, camera, hang up
8. **Settings:** change password or passcode, presence visibility, safety codes

**Screens (chat_backoffice)**
1. Admin login → email OTP
2. **Dashboard**
3. **Users list:** search, filters, last message, current device, bulk approve/suspend
4. **User details:** account, categories, devices, login history, chats, last messages, friends (with their category)/groups, and all actions (suspend, delete account, delete chat history, force logout, reset login)
5. **Chats list:** all chats with delete
6. **Categories:** create, order, rules per category, members of each category
7. **Groups:** create, members, delete
8. **Storage:** disk usage, per-user media, "Run cleanup now"
9. **Activity log:** admin actions

## 13. Build phases
Each phase is a vertical slice: backend API first, then the `chat_app` and `chat_backoffice` screens that use it, tested together before moving on. **Every phase ends with a new APK** in `/projects/mobile_builds/`.

| # | Phase | backend | chat_app | backoffice |
|---|---|---|---|---|
| 0 | Setup: scaffold all 3 repos, PM2, nginx, dev environment; Capacitor + Android SDK + signing key, first APK in `mobile_builds` | ✓ | ✓ | ✓ |
| 1 | Sign-up with approval, OTP / passcode login, one device, device tracking, categories | ✓ | ✓ | ✓ Login, Users list, User details (account, devices, logins), Categories, assign at approval, suspend / delete account |
| 2 | Personal ID + invite codes, friend requests with category check, presence | ✓ | ✓ | ✓ friendships per user, change category |
| 3 | Encryption keys, Keep-alive / Automatic chats (category rules enforced), read receipts, typing | ✓ | ✓ | ✓ Chats list, last messages, delete chat history, Dashboard |
| 4 | Live mode | ✓ | ✓ | |
| 5 | Encrypted files, limits, cleanup | ✓ | ✓ | ✓ Storage |
| 6 | Export with approval | ✓ | ✓ | |
| 7 | Voice and video calls (WebRTC + coturn) | ✓ | ✓ | |
| 8 | Admin groups | ✓ | ✓ | ✓ Groups |
| 9 | Activity log, hardening, deploy | ✓ | ✓ | ✓ |

## 14. Decisions (answered 2026-10-16)
1. **One device per account**, no simultaneous sessions. A new login disconnects the old device. Device information is collected with the user informed (§3.5).
2. **Retention is fixed** for the life of a chat. To change it, start a new chat.
3. **One-to-one chats** for users. **Groups only created by the admin** (§5.3).
4. **Limits:** 100 MB per file, 2 GB per user.
5. **Backoffice** has full user management (list, details, devices, chats, last messages, suspend, delete account, delete chat history) but sees **metadata only**, never message content (§3.3).
6. **Categories** (§4): users can be in several; users never see them; friends only within a shared category; removing a user from a category ends those friendships and purges their chats; each category has its own rules; **Secret = Live only**, deleted when the chat is left.
7. **Adding friends** only by **personal ID** (regenerable) or **one-time invite code**. No search.
8. **Platforms:** web app on the server + **Android APK** (Capacitor, same code), never on a store. APKs go to `/projects/mobile_builds/` after each milestone; the login screen links to the latest one with install instructions. No iOS.
9. **Name and brand:** **H_CHAT**. Logo = the Chat logo from the omranisystems.com gate page. APK file: `h_chat.apk`.
10. **Domains:** `chat.omranisystems.com` (user web app, API, APK download), `adminchat.omranisystems.com` (backoffice), `turn.omranisystems.com` (call relay; must be Cloudflare "DNS only").
11. **Access gate:** the omranisystems.com code gate stays on the chat web pages, but `/api`, `/socket.io` and `/download` bypass it (the app has its own login). The backoffice is also behind the gate (new `adminchat` entry).
12. **Email:** login codes are sent with the same SMTP account as passwordManager (its `EMAIL_*` settings, copied into chat_backend's `.env`).
13. **Visual style:** a mix of the Gym app (dark layered surfaces, rounded cards, Archivo) and the Pass manager (JetBrains Mono for IDs/codes/labels, `//` labels, `[ ]` on destructive actions, grid behind sign-in), with dark burgundy as the brand colour (logo: original shape, recoloured `#8C2A3F` / `#6E1B2B`; buttons `#7E2234`; accent `#C7707E`). Mode colours: Live = cyan, Keep-alive = amber, Automatic = blue. **Approved 2026-10-16** for both chat_app and chat_backoffice. Canvas: https://claude.ai/artifact/WyZ4FueUJzjUYidyZJjxQC
