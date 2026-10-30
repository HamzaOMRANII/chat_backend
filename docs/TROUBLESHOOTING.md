# H_CHAT — where to look when something breaks

For every problem: **1. look at the logs, 2. find the code, 3. write a failing test, 4. fix, 5. `npm run check`,
6. deploy** (`bash /projects/hchat-deploy.sh`). Live health: https://monitoring.omranisystems.com/apps/h-chat.

## First checks (on the server)

```bash
pm2 status h-chat                      # online? how many restarts?
pm2 logs h-chat --lines 100            # live log (JSON lines from pino; errors carry "err")
curl -s http://127.0.0.1:12000/api/health   # {"status":"ok","db":"up"}
systemctl status mongod nginx coturn
nginx -t                               # nginx config valid?
```

Old logs: `/root/.pm2/logs/h-chat-out__<date>.log` and `h-chat-error__<date>.log` (rotated nightly).

## Symptom → where to look

| Symptom | Likely cause | Look at |
|---|---|---|
| Web shows the omranisystems.com code page | Gate cookie missing/expired: normal | `/projects/omranisystems` (gate), `/etc/nginx/snippets/gate.conf` |
| "No connection to H_CHAT" in the app | Backend down, or nginx/Cloudflare | `pm2 status h-chat`, `/api/health`, `/etc/nginx/nginx.conf` (`chat.omranisystems.com` block) |
| Sign-in code email never arrives | Gmail App Password revoked, SMTP blocked | backend log `mailer`; `EMAIL_*` in `.env`; `src/lib/mailer.ts` |
| "Too many wrong attempts. Try again in 30 minutes." | 5 wrong password/code/passcode/secure code in a row | Backoffice → user → **Unlock**; `src/modules/auth/sessions.ts` (`registerFailure`) |
| Secure code refused | Not set, switched off by admin, or erased by a reset | Backoffice → user → "secure code" panel; `auth/routes.ts` `verify-secure-code` |
| User signed out by itself | One session per account: a sign-in elsewhere closes the old one ("kicked") | User's security log; `auth/sessions.ts` `startSession` |
| Messages show as locked / can't be read | The device's keys changed (reinstall, new phone, cleared storage) | `chat_app/src/lib/e2e.ts`; the server can't help: content is end-to-end encrypted |
| Messages don't arrive live (only after reload) | Socket.IO connection failing | browser devtools → Network → `socket.io`; `src/realtime/index.ts`; nginx `/socket.io/` block (Upgrade headers) |
| Calls ring but no audio/video | TURN relay unreachable or out of ports (41 ports ≈ 20–40 relayed calls) | `systemctl status coturn`, `/etc/turnserver.conf`, `TURN_SECRET`; `chat_app/src/lib/calls.ts` |
| No notifications on Android | Firebase key or token issue | `/root/.hchat/firebase-service-account.json`, `FIREBASE_SERVICE_ACCOUNT`; `src/modules/notify/` |
| File upload refused | Per-file 100 MB / per-user 2 GB / disk over 80 % | `src/modules/files/service.ts` (`QUOTA_BYTES`, `DISK_LIMIT`); `df -h /var/lib/h-chat` |
| Phones stuck on "Update required" | Minimum app version set higher than the published APK | Backoffice → Settings → minimum app version; `/projects/mobile_builds/h_chat/latest.json` |
| Web still shows the old version after a release | Browser cache | Ctrl+F5; check `node -p "require('/projects/chat_app/package.json').version"` |
| Backoffice page empty / error | `/api/admin` route failing | browser devtools → Network; backend log; `src/modules/admin/<section>.ts` |
| Tests fail at random | Two backend test runs at once (now refused by a lock), or an app test reading the screen too early | `tests/globalSetup.ts`; use `await screen.findBy…` in app tests |

## Where the data is

| Data | Where |
|---|---|
| Accounts, chats (encrypted), groups, logs | MongoDB `h_chat` on 127.0.0.1:27017 (`mongosh` with the `h_chat` user from `/root/ACCESS.txt`) |
| Encrypted files | `/var/lib/h-chat/media` (`MEDIA_DIR`) |
| APKs | `/projects/mobile_builds/h_chat` |
| Settings and secrets | `chat_backend/.env`; index of all secrets `/root/ACCESS.txt` (never print or commit) |
| Backups | `/projects/system_documentation/ops/omrani-backup.sh` → `/root/backups/nightly/` |

## Undo a bad deploy

```bash
cd /projects/<repo> && git log --oneline -5       # find the last good commit
git checkout <good-commit> -- .                    # or: git revert <bad-commit>
bash /projects/hchat-deploy.sh                     # ships it again (the APK gets a new, higher version)
```

Never reuse an older APK version number: phones only install a higher `versionCode`.
