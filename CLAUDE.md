# TB Chest Counter

## Build & Deploy

- **Docker uses pre-compiled JS from `dist/`** — always run `npm run build` after changing TypeScript before committing. Use that, not a bare `npx tsc`: `build` first runs the pure config-guard tests (`tests/config`), which are the only thing standing between a hand-written literal and a silently-dead reference. GitHub Actions ([ci.yml](.github/workflows/ci.yml)) runs typecheck, the full suite and `npm run build` on every push and PR, and **fails when the rebuilt `dist/` differs from what the commit carries** — the one failure that used to ship silently, since the Dockerfile has no build step of its own.
- Static frontend files in `src/web/public/` are copied directly (no build step needed for CSS/JS/HTML).
- Type check: **`npm run typecheck`** — `src/` AND the tests (`tsconfig.test.json`), exactly what CI runs. A bare `npx tsc --noEmit` checks `src/` only, and vitest strips types, so a stale test fixture passes every test locally and fails only CI: that kept CI red for seven pushes in Oct 2026.
- After pushing, check the run: `gh run list --workflow ci.yml --limit 1`. A red run is reported, even when it isn't from your change.
- The Docker image is Linux-only by design; local dev on any OS is unaffected. Details: [docs/docker-image.md](docs/docker-image.md).

## Project Structure

- `src/` — TypeScript source
- `dist/` — Compiled JS (committed, used by Docker)
- `src/web/public/` — Frontend (vanilla HTML/CSS/JS, no framework)
- `src/scheduler/loop.ts` — Main scan orchestrator
- `src/data/repositories/` — Database access layer (better-sqlite3)
- `src/config/` — Config from env vars, persistent settings in `data/app.env`

## Rules that apply almost everywhere

- **Cloudflare caches `.js`/`.css` by extension and ignores `no-store`.** Every asset URL must be path-versioned (`/v/<BUILD_VERSION>/…`, never `?v=`), and no static file may sit behind auth. When a prod fix "doesn't work", read `cf-cache-status` / `Age` off a real response before re-reading the code. Read [docs/cloudflare-caching.md](docs/cloudflare-caching.md) before touching asset serving.
- **Never call `page.mouse.*`, `page.keyboard.*` or `page.evaluate()` directly** — Playwright puts no timeout on them. Go through [input.ts](src/browser/input.ts) / `withDeadline` ([deadline.ts](src/utils/deadline.ts)).
- **Env toggles only reach the container if listed in `docker-compose.yml`'s `environment:` list.**
- **Do not add a timeout around OCR** — it can never fire. Why: [docs/wedged-browser-liveness.md](docs/wedged-browser-liveness.md).
- **`req.user.clanId` / `req.user.role` are the ACTIVE clan's, not the account's home.** An account can hold extra clans with a role in each; `validateSession` scopes the user to the clan it is viewing, which is what keeps every gate clan-confined. Need the home clan? `getUserById`. Read [docs/multi-clan-accounts.md](docs/multi-clan-accounts.md) before touching auth or user listings.
- **Schema changes: append a migration at version 73 or higher**, then `npm run build && node scripts/update-schema-baseline.mjs` and commit the fixture. See [docs/database-schema.md](docs/database-schema.md).

## Key Behaviors

- Scan interval and other runtime settings persist to `data/app.env` (mounted volume), not `.env` (container-local).
- On startup, any PENDING scan sessions from prior crashes are marked FAILED.
- Chests are written to DB in real-time during scanning, and each Open click claims its chest in-game for good. So a scan that fails or is aborted **keeps every chest it already saved**; the session is only rolled back when it has nothing on disk. Decide that from a DB row count (`persistedChestCount` in [scan-finalize.ts](src/scheduler/scan-finalize.ts)), never from `result.newChests`, which misses anything thrown mid-sweep.
- A scan-in-progress guard prevents concurrent scans.
- Two optional phases run AFTER the scan is finalised, in this order: the daily might snapshot, then the daily Clan Capital resource-history read. Both swallow every error by design — neither may ever surface as a scan failure. See [resource-capture-phase.ts](src/scheduler/resource-capture-phase.ts).

## Read before changing that area

- Resource-history capture (cursor, open game day, date-floor backstop, adding a resource type): [docs/resource-capture.md](docs/resource-capture.md)
- Guards levels and Gold Pass (inferred, never stored): [docs/guards-and-gold-pass.md](docs/guards-and-gold-pass.md)
- Chest identity and name-keyed config (renames): [docs/chest-identity.md](docs/chest-identity.md)
- Browsers (scanner, GPU, profile locks): [docs/browsers.md](docs/browsers.md); login bridge: [docs/login-bridge.md](docs/login-bridge.md)
- Wedged-browser liveness bounds: [docs/wedged-browser-liveness.md](docs/wedged-browser-liveness.md)
- Multi-clan accounts (per-clan roles, the switcher, guest visibility): [docs/multi-clan-accounts.md](docs/multi-clan-accounts.md)

## Logging

- `log.warn`/`log.error` land in a **100-entry** ring buffer surfaced on the System page ([log-buffer.ts](src/utils/log-buffer.ts)). A burst of repeated warnings evicts everything else, so anything on a hot path must coalesce via [log-throttle.ts](src/utils/log-throttle.ts) (one immediate line + one `repeated N×` summary per window).
- Pass `log.warn({ noAlert: true }, ...)` for informational warnings that shouldn't light the System nav dot.
- **An entry is a record, not a live status — it never clears itself.** When a warning reports a condition the app can later see go away, log it with `{ resolveKey: '<condition>' }` and call `resolveEntries(key)` where the condition clears; the entry then leaves "Needs attention" and is shown as resolved. Re-auth is the worked example (`reauthWarningKey` / `clearClanNeedsReauth` in [clan-repo.ts](src/data/repositories/clan-repo.ts)). Without it, "Clan #2 needs re-authentication ×14" sat under Needs attention for days after the login was fixed.
