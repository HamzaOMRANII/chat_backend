# 7. Limits and capacity

## 7.1 Product limits (by design)

| Area | Limit |
|---|---|
| Accounts | Sign-up needs administrator approval; **one active session per account** (signing in elsewhere signs out the previous device) |
| Contacts | Only people sharing a category; ID searches: 10 per hour; invite codes valid 24 h, one use |
| Stored messages | Up to 4,000 characters; kept 30 min to **7 days** (category maximum), then deleted |
| Chat invitations | Expire after 24 h |
| Live chats | Invitation 5 min; wiped when either leaves or after **60 s** without connection; one live chat per pair |
| Files | **100 MB per file**, **2 GB per user** (files they sent and still on the server), deleted with their message |
| Server disk guard | New uploads refused above **80%** disk use (messages and calls keep working) |
| Photo previews | Automatic up to 10 MB, tap to download above |
| Export | Needs the other person's approval; 24 h to save; view-only files of the other side never included; not in groups |
| Groups | **10 members** maximum; created by the admin or requested by a user (admin approval) |
| Group calls | **6 people** at once (mesh) |
| Calls | Ring 45 s; end after 15 s without media connection; voice and video in every category |
| Request limits | 600 requests/min per signed-in session; 120/min per address when not signed in; sign-in 30 per 15 min; sign-up 5 per hour |
| Real-time events | ~200 per second per connection (flood guard) |
| Logs | Admin and security logs kept 90 days |

## 7.2 Platform limits

| Limit | Detail |
|---|---|
| Android only for the native app | No iOS app. iPhones can open the web app in a browser, but this was **never tested**; screenshot blocking and lock-screen call ringing are Android-only |
| Android app fully closed | Notifications and calls arrive through Firebase; the call rings as a high-priority notification, **not** a full-screen lock-screen ring |
| Screenshots of view-only files | Blocked on Android (`FLAG_SECURE`); a browser can only deter (no right-click, blur when unfocused) |
| View-only documents | Photos, videos and text can be viewed in the app; PDF/Office view-only files can't be opened inside the app yet |
| One device at a time | One active session per account: phone **or** computer, not both at once |
| Key storage | Private keys are in app storage, not a hardware keystore (see Security) |
| Single server | No high availability: if the VPS is down, H_CHAT is down |

## 7.3 How many calls can run at the same time?

Three different resources limit calls. The tightest one wins.

### A. Signalling (backend + Socket.IO) — not the bottleneck

Ringing and offers/answers are a few small messages per call. A single Node.js process handles **thousands** of
connected users and hundreds of simultaneous call set-ups.

### B. Direct (peer-to-peer) calls — no server limit

When the two devices connect directly, audio/video **never touches the server**. Their number isn't limited by
the server at all; only by the users' own connections.

### C. Relayed calls (through coturn)

Each device that can't connect directly uses one **TURN allocation**, and each allocation needs **one relay port**.
Since 2026-11-11 (M14) coturn has relay ports **49160–50159 = 1,000 ports**, `total-quota=500` allocations for the
whole server and `user-quota=12` per user (before: 41 ports, 100 allocations).

| Call type | Allocations used | Maximum at the same time (500 allocations) |
|---|---|---|
| 1:1, only one side behind a strict network | 1 | ~**500** |
| 1:1, both sides relayed | 2 | ~**250** |
| Group call of 6, all relayed (mesh: 5 links each) | up to 30 | ~**16** |
| Group call of 4, all relayed | up to 12 | ~40 |

While connecting, a device may briefly open extra allocations (UDP, TCP and TLS are all tried), so the practical
numbers can be lower at peak moments. With these numbers the **bandwidth below is the real limit**, not the ports.

**Bandwidth through the relay** (each relayed stream enters and leaves the server):

| Call | Approx. server traffic |
|---|---|
| Relayed voice call (Opus ~40 kbit/s each way) | ~0.16 Mbit/s |
| Relayed video call (~1.5 Mbit/s each way) | ~6 Mbit/s |

With a 200 Mbit/s server link (check the actual Contabo plan), that's roughly **1,000 relayed voice calls** or
**~30 relayed video calls**: since M14 **bandwidth is the bottleneck, not ports**.

### Realistic summary (since 1.1.2 / M14)

- **Voice calls:** hundreds at the same time (relayed or not).
- **Video calls:** many go direct (no limit); about **30 fully relayed video calls** at once, set by bandwidth.
- **Group calls:** several 6-person relayed video calls fit in the relay; bandwidth again decides.
- **Each phone in a 6-person video call** uploads 5 video streams (~5 Mbit/s): fine on Wi-Fi, heavy on mobile data.

## 7.4 Scaling plan

| Step | Change | Effect |
|---|---|---|
| ~~1~~ **done 2026-11-11 (M14)** | Widen coturn relay range, e.g. `min-port=49152`, `max-port=65535`, raise `total-quota`, open the range in the firewall | Relayed calls limited by bandwidth instead of ports: hundreds of calls |
| 2 | Move coturn to its own small server (or add a second one in another region) | Calls don't compete with the web apps for CPU/bandwidth |
| 3 | Group calls with an SFU (LiveKit, mediasoup, Janus) instead of mesh | Groups of 10+, each phone uploads one stream (E2E via insertable streams) |
| 4 | Socket.IO Redis adapter + several backend processes; MongoDB replica set | More users, no single point of failure for the database |
| 5 | Object storage for encrypted file pieces (S3-compatible) | Media no longer limited by the VPS disk |
