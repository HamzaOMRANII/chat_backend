# 14. Operations runbook

For whoever keeps H_CHAT running. The same content, in short, is in `chat_backend/docs/TROUBLESHOOTING.md`.

## 14.1 Daily / weekly checks

| When | Check | Where |
|---|---|---|
| Daily (email digest 08:00) | h-chat online, no crashes, certificates valid, disk below 80 % | monitoring.omranisystems.com (digest email, `/apps/h-chat`, `/uptime`) |
| Weekly | Pending sign-up requests, group requests, storage use | Backoffice: Dashboard, Users, Groups, Storage |
| Weekly | Last backup date | Monitoring → Security → "Last backup" |
| Monthly | `npm audit` in the three repositories; system updates | server shell |

## 14.2 First commands

```bash
pm2 status h-chat                          # online? restarts?
pm2 logs h-chat --lines 100                # live log (pino JSON)
curl -s http://127.0.0.1:12000/api/health  # {"status":"ok","db":"up"}
systemctl status mongod nginx coturn
nginx -t
df -h / /var/lib/h-chat
```

## 14.3 Symptom → cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Site shows the omranisystems.com code page | Gate cookie missing: normal | Enter the chat gate code |
| `/documentation` asks for a code again | Docs cookie expired (12 h) or cleared | Enter the documentation access code |
| "No connection to H_CHAT" | Backend down, nginx or Cloudflare issue | `pm2 restart h-chat`; check `/api/health`, `nginx -t` |
| Sign-in emails don't arrive | Gmail App Password revoked or SMTP blocked | New App Password in `chat_backend/.env` (`EMAIL_PASSWORD`), restart; meanwhile users can use their secure code |
| "Too many wrong attempts" | 5 failures in a row | Backoffice → user → **Unlock**, or wait 30 min |
| Secure code refused | Not set, switched off, or erased by a reset | Backoffice → user → secure code panel; user sets it again in Settings |
| Messages locked / unreadable on a device | Device keys changed (new phone, reinstall, cleared data) | Expected: E2E. The other side's new messages work again; old ones can't be recovered |
| Live updates stop | WebSocket blocked | nginx `/socket.io/` block (Upgrade headers), Cloudflare WebSockets on |
| Calls connect but no sound / picture | TURN unreachable or out of relay ports | `systemctl status coturn`; `TURN_SECRET` = `static-auth-secret`; widen ports 49160–49200 |
| No notifications on Android | Firebase key/token | `/root/.hchat/firebase-service-account.json`; user re-opens the app |
| Uploads refused | 100 MB/file, 2 GB/user, or disk over 80 % | Backoffice → Storage (ask users to download, delete, cleanup) |
| Phones stuck on "Update required" | Minimum version above the published APK | Backoffice → Settings → minimum version |
| Old version still shown on the web | Browser cache | Ctrl+F5 |

## 14.4 Recovery

| Situation | Steps |
|---|---|
| Backend crash loop | `pm2 logs h-chat --err`; fix or roll back (14.5); `pm2 restart h-chat` |
| MongoDB down | `systemctl restart mongod`; check disk space; logs `/var/log/mongodb/` |
| Server lost | Rebuild a fresh Ubuntu server with `/projects/restore.sh` from the latest downloaded archive of `/projects/backup/OS/` (README there; see also `/projects/system_documentation/04-migration.md`) |
| Suspected compromise | Security chapter §8.4 incident checklist: rotate secrets, force sign-outs, raise minimum version |

## 14.5 Undo a bad release

```bash
cd /projects/<repo> && git log --oneline -5      # find the last good commit
git revert <bad-commit>                           # keeps history
bash /projects/hchat-deploy.sh                    # ships again; the APK gets a new, higher version
```

Never re-publish an older APK version number: Android only installs a higher `versionCode`.
