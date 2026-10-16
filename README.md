# H_CHAT backend

API and real-time server for H_CHAT (Node 24, TypeScript, Express 5, Socket.IO, MongoDB).
Design: [docs/DESIGN.md](docs/DESIGN.md) · Milestones: [docs/MILESTONES.txt](docs/MILESTONES.txt)

## Run

```bash
cp .env.example .env      # fill in secrets (see comments)
npm ci
npm run dev               # http://127.0.0.1:12000, reloads on change
npm test
```

Production runs under PM2 as `h-chat` (`/projects/ecosystem.config.js`) behind nginx:

| Address | Served by |
|---|---|
| `chat.omranisystems.com/api`, `/socket.io` | this server, not gated (the Android app has its own login) |
| `chat.omranisystems.com/download/` | `/projects/mobile_builds` (APKs) |
| `adminchat.omranisystems.com/api/admin` | this server, behind the omranisystems.com gate |

Deploy: `/projects/deploy.sh chat_backend h-chat` (deploys `origin/main`).

## Call relay (coturn)

`turn.omranisystems.com` (DNS only) runs coturn with `use-auth-secret`; `TURN_SECRET` here must equal
`static-auth-secret` in `/etc/turnserver.conf`. Ports: 3478 UDP/TCP, 5349 TLS, relay range 49160–49200 UDP.
Its Let's Encrypt certificate renews automatically (`/etc/letsencrypt/renewal-hooks/deploy/coturn.sh`).
`/usr/local/sbin/turn-egress.sh` stops the relay from opening new connections to this server's own services.
