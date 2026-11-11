# 15. Versions and milestones

| Milestone | What it added | Release |
|---|---|---|
| M0 | Foundations: three repositories, gates, deploy | 0.1 |
| M1 | Accounts: sign-up with admin approval, password + email code, recovery passcode, one session per account | 0.2 |
| M2 | Contacts: personal ID, invite codes, categories with rules, block / remove | 0.3 |
| M3 | Stored chats (Keep-alive 30 min–7 days, Automatic 7 days), end-to-end encryption, safety codes, receipts, notifications | 0.4 |
| M4 | Live chats: letter by letter, nothing stored | 0.5 |
| M5 | Encrypted files (100 MB/file, 2 GB/user), media screens, view-only, admin storage | 0.6 |
| M6 | Export with the other side's approval (zip built on the device) | 0.7 |
| M7 | Voice and video calls (WebRTC, TURN relay, signed offers), ringing when the app is closed, update prompt | 0.8 |
| M8 | Groups (max 10) and group calls (max 6) | 0.9 |
| M9 | Security review, rate limits, flood guard, minimum app version, settings backup / restore | **1.0.0** (2026-10-18) |
| M11 | Secure code: per-user code instead of the email code (hidden field, alert email, admin switch) | **1.1.0** (2026-10-30) |
| M10 | Maintainability: code checker and formatter (Biome), `npm run check`, backoffice API split per section, developer guides, troubleshooting guide, reliable tests; backoffice user *Chats* tab fixed | **1.1.1** (2026-10-30) |
| M12 | This documentation site at `/documentation`, behind the gate and its own access code | backend only |
| M13 | Refactor and speed-up: expiry job in 2 queries a minute, shared message bar / uploads / time helpers, screens loaded on demand (first download 702 → 445 KB), back office chat components split, dependency updates, libsodium pinned | **1.1.2** |

Every release is tagged in `chat_app` (`v1.0.0`, `v1.1.0`, `v1.1.1`); APKs are kept in
`/projects/mobile_builds/h_chat/`.

## Open ideas

- Full-screen ringing over the lock screen (Android full-screen intent).
- Reading view-only PDFs inside the app.
- Accessibility follow-ups listed by `npm run lint` (keyboard equivalents for sheet backdrops, SVG titles).
- Forward secrecy per message (a ratchet) for a 2.0.
