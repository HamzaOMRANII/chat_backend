# 11. UML models

The UML views of H_CHAT, drawn with Mermaid (sources in `documentation/src/11-uml.md`). Use cases and components
use flowchart notation, since Mermaid has no dedicated use-case or component diagram.

## 11.1 Use case diagram

```mermaid
flowchart LR
  V(("Visitor"))
  U(("User"))
  A(("Administrator"))
  subgraph H_CHAT
    UC1([Request access])
    UC2([Sign in: password + email code])
    UC2b([Sign in with secure code])
    UC3([Recover access: passcode / admin reset code])
    UC4([Add a contact by ID or invite])
    UC5([Chat: Keep-alive / Automatic])
    UC6([Live chat: nothing stored])
    UC7([Send encrypted files])
    UC8([Voice / video call, 1:1 or group])
    UC9([Export a chat, with approval])
    UC10([Group chat])
    UC11([Manage settings, secure code, security log])
    UC20([Approve / suspend accounts])
    UC21([Categories and rules])
    UC22([Groups: create, approve requests])
    UC23([Storage and media requests])
    UC24([Chats metadata, delete history])
    UC25([Settings: minimum version, backup / restore])
    UC26([Activity log])
    UC27([Switch a user's secure code off])
  end
  V --> UC1
  U --> UC2 & UC2b & UC3 & UC4 & UC5 & UC6 & UC7 & UC8 & UC9 & UC10 & UC11
  A --> UC20 & UC21 & UC22 & UC23 & UC24 & UC25 & UC26 & UC27
  UC2b -. extends .-> UC2
  UC7 -. includes .-> UC5
```

## 11.2 Class diagram (domain model)

The persistent classes (Mongoose models in `chat_backend/src/models/`). Field lists are shortened; every
collection is described in [Data model](12-data-model.md).

```mermaid
classDiagram
  direction LR
  class User {
    username
    email
    passwordHash
    passcodeHash
    secureCodeHash
    status: pending|approved|rejected|suspended
    role: user|admin
    personalId
    identity.signPub
    categoryIds[]
    failedAttempts
    lockedUntil
  }
  class Session {
    kind: user|reset|admin
    device
    expiresAt
    revokedAt
  }
  class Category {
    name
    order
    rules.modes[]
    rules.maxRetentionDays
    rules.files
    rules.export
    rules.calls
  }
  class Friendship {
    pairKey
    status: pending|accepted
    via: id|invite
    categoryId
  }
  class Chat {
    mode: keep|auto
    retentionMinutes
    status: invited|active|ended
    keys[] (public, signed)
  }
  class Message {
    ciphertext
    nonce
    senderKeyVersion
    expiresAt
    deliveredAt
    readAt
  }
  class Group {
    name
    status: pending|active|refused
    members[]
    keys[] (public, signed)
  }
  class GroupMessage {
    ciphertext
    wraps[] (key per member)
    readBy[]
    expiresAt
  }
  class StoredFile {
    kind
    size
    chunks
    status: uploading|ready|deleted
    expiresAt
  }
  class LiveSession {
    status: invited|active|ended
    keys[]
  }
  class Call {
    kind: voice|video
    status: ringing|active|ended
  }
  class ExportRequest {
    status
    period
    until
  }
  class DeviceEvent {
    type
    device, ip, country, city
    at
  }
  class AdminLog {
    action
    details
    at
  }
  User "1" --> "0..1" Session : active session
  User "*" --> "*" Category : belongs to
  User "2" -- "1" Friendship
  Friendship --> Category : rules from
  User "2" -- "*" Chat
  Chat "1" *-- "*" Message
  Chat "1" o-- "*" StoredFile
  Chat "1" o-- "*" ExportRequest
  Group "1" *-- "*" GroupMessage
  Group "1" o-- "*" StoredFile
  Group --> Category
  User "*" -- "*" Group : member
  User "2" -- "*" LiveSession
  User "*" -- "*" Call
  User "1" -- "*" DeviceEvent
  User "1" -- "*" AdminLog : admin
```

## 11.3 Sequence diagrams

### Sign-in with the secure code

```mermaid
sequenceDiagram
  autonumber
  actor P as Person
  participant App as chat_app (CodePage)
  participant API as chat_backend /api/auth
  participant DB as MongoDB
  participant Mail as SMTP
  P->>App: username + password
  App->>API: POST /login
  API->>DB: user, verify Argon2id(password)
  API->>Mail: 6-digit code (sent anyway)
  API-->>App: challengeId
  P->>App: taps the title 5× → field appears, types secure code
  App->>API: POST /verify-secure-code {challengeId, secureCode}
  API->>DB: challenge valid? account locked? secureCodeHash set and allowed?
  alt wrong / not set / switched off
    API->>DB: attempts+1, failedAttempts+1, event failed_secure_code
    API-->>App: 400 wrong_secure_code (attempts left)
  else correct
    API->>DB: delete challenge, new session (older one revoked), event secure_code_used
    API--)Mail: alert "signed in with your secure code"
    API-->>App: user + cookie (web) or token (Android)
  end
```

### Sending a stored message

```mermaid
sequenceDiagram
  autonumber
  participant A as Alice's app
  participant API as chat_backend
  participant RT as Socket.IO
  participant B as Bob's app
  A->>A: encrypt with Bob's signed chat key (XChaCha20-Poly1305)
  A->>API: POST /api/chats/:id/messages {ciphertext, nonce, key versions}
  API->>API: member? chat active? size ok? expiresAt = now + retention
  API->>RT: bus → msg:new to user:Bob
  API-->>A: 201 message
  RT-->>B: msg:new
  B->>B: decrypt locally
  B->>API: POST /api/chats/:id/receipts (delivered / read)
  API->>RT: msg:status to user:Alice
  RT-->>A: ✓✓ read
  Note over API: cleanup job + TTL index delete it at expiresAt
```

### Starting a 1:1 call

```mermaid
sequenceDiagram
  autonumber
  participant A as Caller app
  participant RT as Socket.IO
  participant B as Callee app
  participant T as coturn
  A->>RT: call:start {to, kind}
  RT->>RT: contacts? rules allow calls? callee receives calls?
  RT-->>B: call:incoming (+ Firebase push if the app is closed)
  B->>RT: call:answer {callId}
  RT-->>A: call:answered
  A->>RT: call:signal {sdp + signature}
  RT-->>B: call:signal
  B->>B: verify the offer's signature with A's identity key
  B->>RT: call:signal {answer sdp + signature}
  RT-->>A: call:signal
  A-->>B: ICE: direct path if possible
  A-->>T: otherwise relay (short-lived HMAC credentials)
  A->>RT: call:leave
  RT-->>B: call:ended
```

## 11.4 State machines

### Account

```mermaid
stateDiagram-v2
  [*] --> pending : request access
  pending --> approved : administrator approves
  pending --> rejected : administrator rejects
  approved --> suspended : suspend
  suspended --> approved : reactivate
  approved --> locked : 5 wrong password / code / passcode / secure code
  locked --> approved : 30 minutes or admin "Unlock"
  approved --> mustReset : recovery passcode or admin reset code
  mustReset --> approved : new password + passcode (secure code erased)
  approved --> [*] : deleted
```

### Stored chat

```mermaid
stateDiagram-v2
  [*] --> invited : Send chat invitation
  invited --> active : other side accepts
  invited --> ended : declined / invitation expires
  active --> ended : either side ends · contact removed · rules no longer allow it · admin deletes
  ended --> [*] : metadata purged after 30 days
  note right of active
    each message expires on its own
    (retention: 30 min to 7 days)
  end note
```

### Contact (friendship), file, call

```mermaid
stateDiagram-v2
  state Friendship {
    [*] --> fpending : request by ID / invite code
    fpending --> accepted : accept
    fpending --> [*] : decline
    accepted --> paused : no shared category any more
    paused --> accepted : category shared again
    accepted --> [*] : removed or blocked
  }
  state File {
    [*] --> uploading
    uploading --> ready : all pieces received
    uploading --> [*] : abandoned 1 h
    ready --> deleted : expiry · sender · administrator
  }
  state Call {
    [*] --> ringing
    ringing --> active : answered
    ringing --> ended : missed / declined
    active --> ended : hang up (in a group the starter ends it for everyone)
  }
```

## 11.5 Component diagram

```mermaid
flowchart LR
  subgraph chat_app
    Pages --> libApi[lib/api.ts]
    Pages --> libE2E[lib/e2e.ts · libsodium]
    Pages --> libCalls[lib/calls.ts · WebRTC]
    Pages --> libSocket[Socket.IO client]
  end
  subgraph chat_backoffice
    BOPages[Pages] --> BOApi[lib/api.ts]
  end
  subgraph chat_backend
    Routers["modules/*/routes.ts"] --> Services["modules/*/service.ts"]
    AdminRouters["modules/admin/*.ts"] --> Services
    Services --> Models["models/*.ts (Mongoose)"]
    Services --> Bus[lib/events.ts]
    Bus --> Realtime[realtime/]
    Jobs[jobs/cleanup.ts] --> Services
    Docs[modules/docs] --> Site[(documentation/site)]
  end
  libApi -- "REST /api" --> Routers
  libSocket -- "WSS /socket.io" --> Realtime
  BOApi -- "REST /api/admin" --> AdminRouters
  Models --> Mongo[(MongoDB)]
  Services --> Media[(media folder)]
```

## 11.6 Deployment diagram

```mermaid
flowchart TB
  subgraph Phone["Android phone"]
    APK["H_CHAT APK (WebView + plugins)"]
  end
  subgraph PC["Browser"]
    WEB["chat_app (web)"]
    BO["chat_backoffice"]
  end
  CF["Cloudflare edge"]
  FB["Firebase Cloud Messaging"]
  subgraph VPS["Contabo VPS · Ubuntu 24.04"]
    NGINX["nginx :443<br/>gate · static dist · proxy"]
    GATE["omranisystems gate :4000"]
    NODE["PM2 h-chat :12000<br/>chat_backend"]
    MONGO[("MongoDB :27017")]
    DISK[("/var/lib/h-chat/media")]
    TURN["coturn :3478 / :5349<br/>relay 49160–49200"]
    APKS[("/projects/mobile_builds/h_chat")]
  end
  APK & WEB & BO -->|HTTPS| CF --> NGINX
  NGINX --> GATE
  NGINX --> NODE
  NGINX --> APKS
  NODE --> MONGO
  NODE --> DISK
  NODE --> FB --> APK
  APK & WEB <-->|"UDP/TCP (not via Cloudflare)"| TURN
```
