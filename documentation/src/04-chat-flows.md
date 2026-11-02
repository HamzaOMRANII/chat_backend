# 4. How chats work

## 4.1 Accounts and sign-in

```mermaid
sequenceDiagram
  autonumber
  participant U as User app
  participant S as Backend
  participant M as Email (SMTP)
  participant A as Administrator (backoffice)
  U->>S: POST /api/auth/signup {username, email, password, passcode}
  S->>S: Argon2id(password), Argon2id(passcode) — status "pending"
  A->>S: approve + choose categories
  U->>S: POST /api/auth/login {username or email, password, device}
  S->>M: 6-digit code (valid 5 min, 5 attempts)
  alt usual
    U->>S: POST /api/auth/verify-code {challengeId, code}
  else secure code (hidden field: 5 taps on the screen title)
    U->>S: POST /api/auth/verify-secure-code {challengeId, secureCode}
    S->>M: alert "signed in with your secure code"
  end
  S->>S: one active session per account (older one revoked → "signed in elsewhere")
  S-->>U: web: httpOnly cookie · Android: bearer token (JWT HS256, 30 days)
  U->>U: create/publish identity key (Ed25519)
```

- **Secure code (1.1.0):** each person may set their own 8–12-digit code in Settings (current password required).
  On the "Check your email" screen, 5 taps on the title within 3 seconds reveal a field where it replaces the
  emailed code. The password step is still required; wrong codes count toward the lock; every use sends an alert
  email and appears in the security log; any credentials reset erases it; the administrator can switch it off per user.
- Lost email access: the **8-digit recovery passcode** replaces the email code once, then forces new credentials.
- Too many wrong attempts lock the account for 30 minutes.
- Socket.IO connections use a 60-second **socket ticket** (web) or the bearer token (Android).

## 4.2 Contacts and categories

```mermaid
flowchart LR
  A["Alice"] -->|"invite code (24 h, one use)<br/>or personal ID HC-XXXX-XXXX (request)"| B["Bob"]
  B -->|accepts| F["Friendship"]
  F -->|"shared category<br/>(admin decides)"| R["Rules: modes · max retention ·<br/>files · export · calls"]
```

- Two people can only be contacts if the administrator put them in **at least one common category**.
- The category decides what they may do: Live / Keep-alive / Automatic, how long messages stay (30 min–7 days),
  files, export, calls.
- ID searches are limited to 10 per hour. Blocking is silent and permanent.

## 4.3 Chat modes

| Mode | Stored on the server? | Lifetime | Notes |
|---|---|---|---|
| **Keep-alive** | Yes, encrypted | Each message: 30 min … 7 days (category maximum) | Chosen when starting, can't change |
| **Automatic** | Yes, encrypted | Each message: 7 days | |
| **Live** | **Never** | While both are connected | Letter-by-letter typing; wiped when either leaves or after 1 minute without connection |

## 4.4 Stored chat lifecycle

```mermaid
stateDiagram-v2
  [*] --> invited: Alice starts (mode + duration)
  invited --> active: Bob accepts (adds his key)
  invited --> ended: declined / cancelled / 24 h without answer
  active --> ended: either ends it · rules change · contact removed · all messages expired
  ended --> [*]: messages + keys deleted at once<br/>metadata kept 30 days for the backoffice
```

## 4.5 Live chat

```mermaid
sequenceDiagram
  autonumber
  participant A as Alice
  participant S as Backend (memory only)
  participant B as Bob
  A->>S: POST /api/live {userId, key}
  S-->>B: notification + live:changed (answer within 5 min)
  B->>S: POST /live/:id/accept {key}
  S-->>A: live:accepted
  loop every keystroke
    A->>A: encrypt {t: "draft", text, n}
    A->>S: socket "live" {sessionId, nonce, ct}
    S-->>B: relay (never stored)
    B->>B: decrypt → shows the draft live
  end
  Note over S: a side disconnects → 60 s grace → live:ended for both
  A->>S: DELETE /live/:id (leave) → live:ended → both screens wiped
```

## 4.6 Groups

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant S as Backend
  participant A as Administrator
  alt created by the administrator
    A->>S: POST /api/admin/groups {name, category, retention, members ≤ 10}
  else asked by a user
    U->>S: POST /api/groups/requests {name, contacts}
    S-->>A: appears under "asked by users"
    A->>S: PUT /api/admin/groups/:id (approve: rules, members)
  end
  S-->>U: group:changed
  U->>S: POST /groups/:id/keys (publish group key)
  U->>S: POST /groups/:id/messages {ciphertext, wraps for every member}
  S-->>U: group:msg to each member (with only their own wrap)
```

Members can leave; the administrator adds and removes people. Export and live chat aren't available in groups.

## 4.7 Export (approval-based)

```mermaid
sequenceDiagram
  participant A as Requester
  participant S as Backend
  participant B as Other person
  A->>S: POST /chats/:id/exports {messages, media, period}
  S-->>B: export_request notification + card in the chat
  B->>S: POST /exports/:id/approve (or refuse)
  S-->>A: approved → 24 h window
  A->>A: download + decrypt everything on the device,<br/>build zip (chat.html, chat.txt, media/) — view-only files of the other side left out
  A->>S: POST /exports/:id/downloaded (recorded)
```

## 4.8 Notifications

```mermaid
flowchart TB
  E["Event (message, invitation, call…)"] --> N["notify(userId, kind, title, body)"]
  N --> O{"App on screen?"}
  O -- yes --> SO["Socket.IO 'notify' → in-app banner"]
  O -- no --> PREF{"User's preference<br/>for this kind on?"}
  PREF -- no --> X["nothing"]
  PREF -- yes --> FCM["Firebase (Android): generic text"]
  PREF -- yes --> WP["Web Push (browsers): sender name + generic text,<br/>encrypted for the browser"]
```

## 4.9 Expiry and cleanup

| What | When it goes |
|---|---|
| Messages | At `expiresAt` (MongoDB TTL index) |
| Files | Every minute: expired, abandoned uploads (1 h), admin deadlines; on chat end; by sender/recipient |
| Chats | Invitation unanswered 24 h; all messages expired; ended chats' metadata after 30 days |
| Live chats | Invitation 5 min; 60 s without connection |
| Export approvals | 24 h |
| Admin and security logs | 90 days |
