# 12. Data model

MongoDB 8, database `h_chat`, one Mongoose model per collection in `chat_backend/src/models/`. There are no
migrations: a new field needs a `default` or code that handles `undefined`. **Expiry** is done by TTL indexes
(MongoDB deletes the document when the date passes) plus the cleanup job (`jobs/cleanup.ts`).

Legend: 🔒 secret, never sent to clients (`select: false` + removed in `toJSON`) · 🔐 end-to-end encrypted:
the server cannot read it · ⏱ TTL index.

## 12.1 Accounts and access

### `users`
| Field | Type | Notes |
|---|---|---|
| `username`, `email` | string, unique, lowercase | Sign-in with either |
| `passwordHash` 🔒, `passcodeHash` 🔒 | Argon2id | Password (12+ chars) and 8-digit recovery passcode |
| `secureCodeHash` 🔒, `secureCodeSetAt`, `secureCodeDisabled` | Argon2id, date, bool | Secure code (1.1.0); erased by credentials resets; admin switch |
| `adminResetHash` 🔒, `adminResetExpiresAt` | Argon2id, date | One-time 10-digit code from the backoffice (24 h) |
| `role` | `user` \| `admin` | Admins only use the backoffice |
| `status` | `pending` \| `approved` \| `rejected` \| `suspended` | See the account state machine (UML §11.4) |
| `categoryIds` | ObjectId[] → categories | Decides who may talk to whom and how |
| `personalId` | `HC-XXXX-XXXX`, unique | Given at approval, can be changed |
| `identity` | `{ deviceId, signPub, at }` | Public Ed25519 identity key of the signed-in device |
| `notify`, `receiveCalls` | booleans | Preferences |
| `mediaRequest` | `{ deadline, requestedAt, reminded }` | Admin asked the user to download media |
| `mustReset` | bool | After passcode/admin-reset sign-in: new credentials first |
| `failedAttempts`, `lockedUntil` | number, date | 5 failures → 30-minute lock |
| `activeSessionId`, `lastSeenAt`, `approvedAt/By`, `privacyAcceptedAt`, … | | Bookkeeping |

### `sessions`
`userId`, `kind` (`user` 30 days · `reset` 15 min · `admin` 2 h), `device` (name, platform, model, app version,
browser, os, ip, country, city), `revokedAt`, `revokeReason` (`new_login`, `logout`, `suspended`, `admin`,
`credentials_changed`, `deleted`), `revokedBy`, `expiresAt` ⏱ (+1 day). One active user session per account.

### `challenges` ⏱
Pending email codes: `userId`, `purpose` (`login`, `admin-login`, `email-change`), `codeHash` (SHA-256),
`attempts` (max 5), `newEmail`, `device`, `expiresAt` (5 minutes). The secure code answers a `login` challenge.

### `deviceevents` ⏱ 90 days
The security log: `userId`, `type` (`signup`, `login`, `logout`, `kicked`, `failed_password`, `failed_code`,
`failed_passcode`, `passcode_used`, `failed_secure_code`, `secure_code_used`, `secure_code_set`,
`secure_code_removed`, `admin_reset_used`, `credentials_reset`, `email_changed`, `locked`) + device and network
details + `at`. Shown to the user (My security log) and the administrator.

### `adminlogs` ⏱ 90 days
`adminId`, `action` (e.g. `user.approved`, `user.secure_code_disabled`, `user.chats_deleted`), `targetUserId`,
`details`, `at`.

## 12.2 Contacts

| Collection | Fields | Notes |
|---|---|---|
| `categories` | `name` (unique), `order`, `rules { modes[live,keep,auto], maxRetentionDays 0–7, files all/p2p/none, export, calls none/voice/video }` | Two users can be contacts only if they share one |
| `friendships` | `userA`, `userB`, `pairKey` (unique), `status` pending/accepted, `requestedBy`, `via` id/invite, `categoryId`, `acceptedAt` | Without a shared category the pair is *paused* (computed, not stored) |
| `invites` ⏱ | `ownerId` (unique), `code` (unique), `expiresAt` | One-time invite code, 24 h |
| `blocks` | `blockerId`, `blockedId` (unique pair) | Silent and permanent |
| `lookups` ⏱ 1 h | `userId`, `at` | Counts ID searches (10 per hour) |

## 12.3 Conversations

### `chats` (stored chats)
`participants[2]`, `pairKey` (**one open chat per pair**: unique partial index on invited/active), `mode`
(`keep` \| `auto`), `retentionMinutes`, `status` (`invited`, `active`, `ended`), `createdBy`, `categoryId`,
`keys[]` (public chat keys: `userId`, `version`, `pub`, `sig`, `identityPub`), `invitedAt`, `inviteExpiresAt`,
`acceptedAt`, `endedAt/By/Reason`, `lastMessageAt`, `messageCount`, `storedBytes`, `purgeAt` ⏱ (30 days after end).

### `messages` ⏱ at `expiresAt`
`chatId`, `senderId`, `recipientId`, `ciphertext` 🔐, `nonce`, `senderKeyVersion`, `recipientKeyVersion`, `size`,
`fileId`, `sentAt`, `deliveredAt`, `readAt`, `expiresAt`. Indexes: `(chatId, sentAt)`, `(recipientId, readAt)`.

### `groups` and `groupmessages`
- `groups`: `name`, `status` (`pending` request · `active` · `refused`), `requestedBy`, `categoryId`, `mode`,
  `retentionMinutes`, `members[]` (max 10), `keys[]` (public, signed), `createdBy`, `lastMessageAt`,
  `messageCount`, `purgeAt` ⏱.
- `groupmessages` ⏱: `groupId`, `senderId`, `ciphertext` 🔐, `nonce`, `wraps[]` (the message key encrypted for
  each member 🔐), `system` (member joined/removed lines), `fileId`, `size`, `readBy[]`, `sentAt`, `expiresAt`.

### `livesessions`
`participants`, `pairKey` (one open live per pair), `status`, `createdBy`, `categoryId`, `keys[]` (deleted at the
end), `invitedAt`, `startedAt`, `endedAt/By/Reason`, `purgeAt` ⏱ (30 days). **Nothing typed is stored.**

### `calls`
`participants`, `startedBy`, `kind` (voice/video), `status` (ringing/active/ended), `ringingAt`, `answeredAt`,
`endedAt`, `endReason`, `endedBy`, `purgeAt` ⏱. Audio and video never pass through the application.

## 12.4 Files and exports

| Collection | Fields | Notes |
|---|---|---|
| `files` | `chatId` or `groupId`, `senderId`, `recipientId`, `kind`, `size` (encrypted), `chunks`, `got[]`, `status` uploading/ready/deleted, `messageId`, `expiresAt`, `deletedAt/Reason`, `purgeAt` ⏱ | Name, type and key are inside the encrypted message 🔐; pieces on disk in `/var/lib/h-chat/media/<fileId>/<n>` 🔐 |
| `exportrequests` | `chatId`, `requestedBy`, `approverId`, `messages`, `media`, `period` all/24h/7d, `counts`, `status` pending/approved/refused/expired/cancelled, `until`, `downloadedAt`, `purgeAt` ⏱ | The zip is built on the requester's device |

## 12.5 Notifications and settings

| Collection | Fields |
|---|---|
| `pushsubscriptions` | `userId`, `sessionId`, `endpoint` (unique), `p256dh`, `auth` (Web Push) |
| `fcmtokens` | `userId`, `sessionId`, `token` (unique) (Android, Firebase) |
| `settings` | `key` (unique), `value`, `at`: e.g. `minAppVersion` |

## 12.6 What is deleted when

| Data | Deleted |
|---|---|
| Message / group message | At its `expiresAt` (30 min – 7 days after sending) |
| File pieces | With their message; abandoned uploads after 1 hour; by the administrator on request |
| Live chat text | Never stored; keys deleted when it ends |
| Chat, live, call, group metadata | 30 days after it ends (`purgeAt`) |
| Email codes | 5 minutes |
| Security log, admin log | 90 days |
| Sessions | 1 day after expiry |
