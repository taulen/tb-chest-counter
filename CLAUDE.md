# TB Chest Counter

## Build & Deploy

- **Docker uses pre-compiled JS from `dist/`** — always run `npm run build` after changing TypeScript before committing. Use that, not a bare `npx tsc`: `build` first runs the pure config-guard tests (`tests/config`), which are the only thing standing between a hand-written literal and a silently-dead reference. GitHub Actions ([ci.yml](.github/workflows/ci.yml)) runs typecheck, the full suite and `npm run build` on every push and PR, and **fails when the rebuilt `dist/` differs from what the commit carries** — the one failure that used to ship silently, since the Dockerfile has no build step of its own.
- Static frontend files in `src/web/public/` are copied directly (no build step needed for CSS/JS/HTML).
- Type check: **`npm run typecheck`** — `src/` AND the tests (`tsconfig.test.json`), exactly what CI runs. A bare `npx tsc --noEmit` checks `src/` only, and vitest strips types, so a stale test fixture passes every test locally and fails only CI: that kept CI red for seven pushes in Oct 2026.
- After pushing, check the run: `gh run list --workflow ci.yml --limit 1`. A red run is reported, even when it isn't from your change.
- **Deploy only with `node scripts/deploy-when-idle.mjs`** (run it in the background). A redeploy mid-scan loses the cycle, and one completed scan session does NOT mean idle: a cycle scans clans in lanes (different accounts at once, one account in turn — [scan-lanes.ts](src/scheduler/scan-lanes.ts)) with gaps where nothing is pending. The script waits on prod's own `/api/health` → `scanner.busy` (whole cycle + manual scans) and a 5-min margin to the next cycle, then fires the webhook and confirms the new build. A hook in [.claude/settings.json](.claude/settings.json) refuses any direct webhook call. Config: gitignored `deploy.local.json`.

## Project Structure

- `src/` — TypeScript source
- `dist/` — Compiled JS (committed, used by Docker)
- `src/web/public/` — Frontend (vanilla HTML/CSS/JS, no framework)
- `src/scheduler/loop.ts` — Main scan orchestrator
- `src/data/repositories/` — Database access layer (better-sqlite3)
- `src/config/` — Config from env vars, persistent settings in `data/app.env`

## Rules that apply almost everywhere

- **Cloudflare caches `.js`/`.css` by extension and ignores `no-store`.** Every asset URL must be path-versioned (`/v/<BUILD_VERSION>/…`, never `?v=`), and no static file may sit behind auth. When a prod fix "doesn't work", read `cf-cache-status` / `Age` off a real response before re-reading the code. Read [docs/cloudflare-caching.md](docs/cloudflare-caching.md) before touching asset serving.
- **In the login bridge, never await `page.mouse.*`, `page.keyboard.*` or `page.evaluate()` unbounded** — Playwright puts no timeout on them. Wrap them in `withDeadline` / `settleWithDeadline` ([deadline.ts](src/utils/deadline.ts)).
- **Env toggles only reach the container if listed in `docker-compose.yml`'s `environment:` list.**
- **`req.user.clanId` / `req.user.role` are the ACTIVE clan's, not the account's home.** An account can hold extra clans with a role in each; `validateSession` scopes the user to the clan it is viewing, which is what keeps every gate clan-confined. Need the home clan? `getUserById`. Read [docs/multi-clan-accounts.md](docs/multi-clan-accounts.md) before touching auth or user listings.
- **UI text is translated (en/es/fr/ru/de).** Every user-visible string goes through `t()`/`tn()` from [lib/i18n.js](src/web/public/lib/i18n.js) with a string literal, and needs an entry in all four `lib/i18n/*.js` dictionaries — `npm run build` fails otherwise. Game names (chests, sources, events, resources, titles, captains…) use `tGame()` at display points only; their translations come from the game's own translation files (`/api/game-texts`, built with names.json), and the hand `game` block keeps only the ~13 names the game never writes — never hand-copy a game name there. Read [docs/i18n.md](docs/i18n.md).
- **Schema changes: append a migration at version 73 or higher**, then `npm run build && node scripts/update-schema-baseline.mjs` and commit the fixture. See [docs/database-schema.md](docs/database-schema.md).

## Key Behaviors

- Scan interval and other runtime settings persist to `data/app.env` (mounted volume), not `.env` (container-local).
- On startup, any PENDING scan sessions from prior crashes are marked FAILED.
- **Scans read the game directly** ([protocol-scan.ts](src/scheduler/protocol-scan.ts), Nov 2026): capture → record every gift keyed by `game_gift_id` → claim it (15013) → ledger rows keyed by `game_entry_id`. Recording comes BEFORE claiming, and a claim is permanent in-game, so a scan that fails or is aborted **keeps every chest it already saved**; the session is only rolled back when it has nothing on disk. Decide that from a DB row count (`persistedChestCount` in [scan-finalize.ts](src/scheduler/scan-finalize.ts)), never from `result.newChests`.
- A scan-in-progress guard prevents concurrent scans.
- **Every clan is on its own schedule** ([scan-due.ts](src/scheduler/scan-due.ts), Nov 2026): its Clans-page interval (floor 10 min, `MIN_CLAN_SCAN_INTERVAL_MINUTES`) else the global one, counted from its last scan. The timer fires for the soonest clan due; a cycle scans only the clans due by then. `getNextScanAtForClan` is one clan's next scan (headers, Home), `getNextScanAt` the soonest of all (the deploy gate). Until then `scan_interval_minutes` was stored but nothing read it.
- Members, might/hero snapshots and departures come from the game every scan ([member-sync.ts](src/game-protocol/member-sync.ts)). The browser/OCR scanner (calibration, OCR might and resource-history captures) was removed in Nov 2026; history it recorded stays readable. The only browser left is the login bridge's.

## Read before changing that area

- **Game patches** — names, research trees, art and the login's client version rebuild from the game's files every patch; one that can't be read keeps the previous patch's, alerts on System (→ Game Patch card) and opens a `game-patch` GitHub issue from the hourly canary. Fixing one starts with `node scripts/game-patch-check.mjs`: [docs/game-patches.md](docs/game-patches.md)
- Game protocol / direct client (src/game-protocol; it IS the scan since Nov 17 2026; game_* tables v102–v103; never present an old website token — it ends the account's session): [docs/game-protocol.md](docs/game-protocol.md)
- Adding a resource type the game introduced (migration + icon): [docs/game-protocol.md](docs/game-protocol.md)
- Guards levels (Guardsmen tier from research) and Gold Pass (the game's flag; no donation inference any more): [docs/guards-and-gold-pass.md](docs/guards-and-gold-pass.md)
- Chest identity and name-keyed config (renames): [docs/chest-identity.md](docs/chest-identity.md)
- Chest point values have a history (v99): a save applies "from today on" or to all history; records score the values of the day they were earned; dated changes only write what they change. Read before touching points, scans' point lookup or Recalculate: [docs/chest-points-history.md](docs/chest-points-history.md)
- Browser (login bridge only: GPU, profile locks, unbounded Playwright calls): [docs/browsers.md](docs/browsers.md); login bridge: [docs/login-bridge.md](docs/login-bridge.md)
- Multi-clan accounts (per-clan roles, the switcher, guest visibility): [docs/multi-clan-accounts.md](docs/multi-clan-accounts.md)
- Performance page scoring (weights, thresholds, tenure; retune in one config file): [docs/performance-page.md](docs/performance-page.md)
- Citadel simulator (battle rules measured from real reports, troop/defender data, game01master sizing, per-account saved armies): [docs/citadel-simulator.md](docs/citadel-simulator.md)
- Stack calculator (Tools → Stacks: Kaiculator's sizing ported and pinned count-for-count by 19 probed armies, deliberate differences, how to re-probe, where the 53 mercenaries come from): [docs/stack-calculator.md](docs/stack-calculator.md)
- Rewards tool (Tools → Rewards: clan Dragon Coins/fragments split by Olympus points, Dark Omens Essence or Spoils of Dread damage; exclusions; why fragments may differ from totalcalculator by 1): [docs/rewards-tool.md](docs/rewards-tool.md)
- Seasonal Kingdom clans (v100 `clans.seasonal_kingdom`): events follow tbclanportal's SK feed (`?realm=season`), archive is per realm, corrections are normal-kingdom only, SK Tinman weeks are `ancients-sk` (5 days; anchor is per season — a cadence warning says when to move it): [docs/seasonal-kingdoms.md](docs/seasonal-kingdoms.md)
- Posting into in-game chat (the opt-in daily chat digest): at most ONE message per clan per game day, reserved in `chat_digest_posts` before sending; never the clan, kingdom or private chats (`assertPostableChannel`) — the ONLY private-chat sends are account-invite codes and chat command replies, through their own `sendInviteMessage`/`sendCommandReply` + `assertInviteChannel` (1:1 with one roster player, no links in the text); never resend an `unknown` outcome; `CHAT_SEND_DISABLED=1` kills all sending: [docs/chat-digest.md](docs/chat-digest.md)
- Chat commands (`me`, `top`, `missing`… DM'd to the scanner account, opt-in per clan; optionally also answered in the digest's group chat and ONLY that one — `assertCommandGroupChannel`): never a reply to anything that isn't a command, a scan started for one only when no game session is kept (after a restart, like a code request), every reply one message within the chat's `max_length_message` (lists fit with "… and N more"), strict per-minute/hour limits so the game doesn't mute the account: [docs/chat-commands.md](docs/chat-commands.md)
- Dragon Coins back to members (opt-in per clan; the scanner account, Leader/Superior only, sends each member the kind-4 Dragon Coins their event rewards put in the treasury via 15019; NEVER kinds 5/8 — what the clan won; only coins after the switch went on; reserved before sending, the ledger confirms; `DRAGON_COIN_RETURNS_DISABLED=1` stops all): [docs/dragon-coin-returns.md](docs/dragon-coin-returns.md)
- Accounts from the game (invite codes by DM, `/join`, `user_game_links`; roles follow the in-game rank every scan — Leader/Superior admin, both directions; superadmin never linked; welcome codes' first live send untested): [docs/account-invites.md](docs/account-invites.md)
- A clan's week (`clans.week_start`: Sunday, Tinman, SK Tinman, or `custom:<first day>:<days>`) — one cadence per shape, server `game-day.ts` and client `lib/week-shape.js`/`period.js` held together by the parity test; changing it re-cuts history: [docs/clan-week.md](docs/clan-week.md)
- Weekly points goal is historical (v93 `clan_goal_history`); anything judging a PAST window goes through `weeklyGoalForWindow` / `resolveWeeklyGoalForWindow`, never today's number. Amber means "on pace" (the `{ pace }` judge in lib/leaderboard-render.js; no percent setting since Nov 20 2026), and the Members board is the clan's ranking (the Leaderboard page folded into it; `#leaderboard` links redirect): [docs/performance-page.md#weekly-goal-history](docs/performance-page.md#weekly-goal-history)
- Any page's UI (the redesign's kit: sub-tab bar, period scrubber, tiles, rows, tables, notices, error states; copy and phone-first rules): build from [lib/ui-kit.js](src/web/public/lib/ui-kit.js) + style.css "UI kit", never a page-local copy — [docs/design-standard.md](docs/design-standard.md)
- Running the dashboard locally + screenshots per language/viewport (ask first unless requested): [.claude/skills/local-ui-check/SKILL.md](.claude/skills/local-ui-check/SKILL.md)

## Logging

- `log.warn`/`log.error` land in a **100-entry** ring buffer surfaced on the System page ([log-buffer.ts](src/utils/log-buffer.ts)). A burst of repeated warnings evicts everything else, so anything on a hot path must coalesce via [log-throttle.ts](src/utils/log-throttle.ts) (one immediate line + one `repeated N×` summary per window).
- Pass `log.warn({ noAlert: true }, ...)` for informational warnings that shouldn't light the System nav dot.
- **An entry is a record, not a live status — it never clears itself.** When a warning reports a condition the app can later see go away, log it with `{ resolveKey: '<condition>' }` and call `resolveEntries(key)` where the condition clears; the entry then leaves "Needs attention" and is shown as resolved. Re-auth is the worked example (`reauthWarningKey` / `clearClanNeedsReauth` in [clan-repo.ts](src/data/repositories/clan-repo.ts)). Without it, "Clan #2 needs re-authentication ×14" sat under Needs attention for days after the login was fixed.
