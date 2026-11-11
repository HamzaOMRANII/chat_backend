# 5. How calls work

## 5.1 Principles

- Calls use **WebRTC**, built into browsers and the Android System WebView.
- Audio and video go **directly between the devices** whenever the networks allow it. Otherwise they go **through
  the TURN relay** on the H_CHAT server, still encrypted (DTLS-SRTP): the relay forwards packets it can't read.
- The backend only does **signalling** (ringing, offers/answers, network candidates) over Socket.IO. It never
  receives audio or video.
- Every offer and answer is **signed with the caller's/callee's identity key** and verified by the other side
  (see [Encryption §3.8](03-encryption.md#38-calls)).

## 5.2 1:1 call

```mermaid
sequenceDiagram
  autonumber
  participant A as Caller app
  participant S as Backend (Socket.IO)
  participant F as Firebase
  participant B as Callee app
  A->>S: call:start {to: Bob, kind: voice|video}
  S->>S: contacts? Bob takes calls? online or registered with Firebase? not busy?
  alt Bob turned calls off
    S-->>A: {error: not_taking_calls} → "isn't taking calls right now…"
  else Bob's app open
    S-->>B: call:incoming {callId, from, kind}
  else Bob's Android app closed
    S->>F: "Incoming call" (Calls channel, high priority, 45 s)
    F-->>B: notification → tap → app opens → server rings again
  end
  B->>S: call:answer {callId}
  S-->>A: call:answered
  A->>S: GET /api/calls/turn (1-hour TURN credentials)
  A->>B: offer + signature (via call:signal)
  B->>A: answer + signature (via call:signal)
  A-->>B: ICE candidates both ways (via call:signal)
  Note over A,B: ICE picks the path: direct, or through coturn
  A-->>B: DTLS handshake → encrypted audio/video (SRTP)
  A->>S: call:leave → call:ended for both
```

Unanswered after **45 seconds** → missed call (notification). If one side loses its connection for **15 seconds**
the call ends on both sides; if a device loses its socket for **30 seconds** the server ends its calls.

## 5.3 Finding a path: direct or relayed

```mermaid
flowchart TB
  A["Device A"] -- "1. host candidates<br/>(same Wi-Fi)" --> B["Device B"]
  A -- "2. STUN: public address<br/>stun:turn.omranisystems.com:3478" --> STUN["coturn (STUN)"]
  A -- "3. TURN relay (UDP 3478 · TCP 3478 · TLS 5349)<br/>when NAT/firewall block 1 and 2" --> TURN["coturn (TURN)<br/>relay ports UDP 49160–50159"]
  TURN --> B
```

| Network situation | Typical path |
|---|---|
| Both on Wi-Fi at home / office | Direct |
| One on mobile data (carrier NAT) | Often relayed |
| Strict company Wi-Fi blocking UDP | Relayed over TCP or TLS 5349 |

The call screen shows **"direct"** or **"through the relay"**.

TURN credentials are short-lived (1 hour) and per user: `username = "<expiry>:<userId>"`,
`password = HMAC-SHA1(TURN_SECRET, username)` (coturn `use-auth-secret`). The relay refuses to forward to private,
loopback and multicast addresses (`denied-peer-ip`), so it can't be used to reach the server's internal network.

## 5.4 Group calls (up to 6 people)

Group calls use a **mesh**: every device connects to every other device. There's no media server.

```mermaid
flowchart LR
  A((Alice)) <--> B((Bob))
  A <--> C((Carol))
  A <--> D((Dave))
  B <--> C
  B <--> D
  C <--> D
```

```mermaid
sequenceDiagram
  autonumber
  participant A as Alice (starter)
  participant S as Backend
  participant B as Bob
  participant C as Carol
  A->>S: call:start {groupId, kind}
  S-->>B: call:incoming {group}
  S-->>C: call:incoming {group}
  B->>S: call:join → {joined: [Alice]}
  S-->>A: call:joined {Bob}
  B->>A: offer + signature (the newcomer connects to everyone already in)
  C->>S: call:join (later, from the "Join" banner) → {joined: [Alice, Bob]}
  S-->>A: call:joined {Carol}
  S-->>B: call:joined {Carol}
  C->>A: offer
  C->>B: offer
  B->>S: call:leave → others continue
  A->>S: call:leave {everyone: true} → only the starter can end it for all
```

Rules: maximum **6 people at once** (the 7th sees "Full"); members can join while it runs; the call ends when the
starter ends it for everyone, or when only one person is left; nobody joins within 45 s → missed.

## 5.5 Audio quality: noise, echo and routing

| Stage | Where | What |
|---|---|---|
| Capture | Device | `getUserMedia` with **noise suppression**, **echo cancellation**, **automatic gain control** (WebRTC Audio Processing Module, on the device) |
| Encode | Device | Opus (adaptive bitrate, packet-loss concealment) |
| Transport | Network | SRTP over UDP (or TCP/TLS through the relay) |
| Playback | Device | Separate `<audio>` element per remote person, restarted if Android pauses it |
| Routing (Android) | `CallAudioPlugin` | Headset/earbuds → earpiece → loudspeaker (on demand); call volume on the volume keys; screen off at the ear |
| Background (Android) | `CallService` | Foreground "call in progress" service keeps the microphone (and camera) with the screen off |

Users can check their devices: in a call, **Sound** shows "their voice" and "your mic" level meters, lets them pick
the output (by name) and the microphone, and plays a test sound. **Settings › Calls › Test microphone and speaker**
records 3 seconds and plays them back.

## 5.6 Settings and rules

- **Receive calls** (per user): off → callers see "isn't taking calls right now… for their own reasons. That's
  their choice: you can still write to them."
- Calls are available in **every category**, voice and video, 1:1 and in groups.

## 5.7 Diagnostics

Each device reports, 5 s / 15 s / 30 s into a call, **numbers only** to the server log (`"call audio"`): bytes and
packets received, audio energy, player state, output route, direct/relayed. No audio is ever sent. This is how
the Android earpiece and paused-player problems were found and fixed.
