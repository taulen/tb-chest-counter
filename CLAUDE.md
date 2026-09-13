# TB Chest Counter

## Build & Deploy

- **Docker uses pre-compiled JS from `dist/`** — always run `npm run build` after changing TypeScript before committing. Use that, not a bare `npx tsc`: `build` first runs the pure config-guard tests (`tests/config`), which are the only thing standing between a hand-written literal and a silently-dead reference. GitHub Actions ([ci.yml](.github/workflows/ci.yml)) runs typecheck, the full suite and `npm run build` on every push and PR, and **fails when the rebuilt `dist/` differs from what the commit carries** — the one failure that used to ship silently, since the Dockerfile has no build step of its own.
- Static frontend files in `src/web/public/` are copied directly (no build step needed for CSS/JS/HTML).
- Compile check only (no emit): `npx tsc --noEmit`
- Full compile: `npx tsc`
- **The Docker image is Linux-only by design.** To trim ~220MB, the build prunes `onnxruntime-node`'s bundled native libraries down to the build platform's arch — it keeps only `linux/<arch>` and strips the macOS/Windows binaries. Building a non-Linux image would need that prune step (in the `npm ci` layer of the [Dockerfile](Dockerfile)) removed. This does **not** affect local dev on any OS: `node_modules` is `.dockerignore`d and reinstalled fresh inside the container, so your local install keeps every platform's binaries.

## Cloudflare caches static assets and ignores `no-store`

Prod sits behind Cloudflare, which caches by **file extension**: a `.js` or `.css` response is stored at the edge for hours regardless of what `Cache-Control` the origin sent. Verified in prod — `/lib/state.js` leaves the origin with `no-store, no-cache, must-revalidate` and comes back `cf-cache-status: HIT`, `Age: 56796`, its `Cache-Control` rewritten to a `max-age`. HTML is passed through (`DYNAMIC`), so only assets are affected. **Never reason about production asset caching from the origin's headers — read `cf-cache-status` / `Age` off a real response.**

Two consequences, both of which have already cost an outage:

- **Every asset URL the browser fetches must be path-versioned** — `/v/<BUILD_VERSION>/lib/ui.js`, never `/lib/ui.js` or `/lib/ui.js?v=…`. A new build asks for URLs no cache has seen, which is what makes a deploy self-healing. The single rewriter is [asset-versioning.ts](src/web/asset-versioning.ts); both HTML shells go through it. **A `?v=` query string is not a substitute**: it is not part of the base URL an ES module's relative import resolves against, so it versions the entry point and *none* of its imports — and Cloudflare may key on path alone anyway. Only rewrite the entry-point `<script src>`; the prefix rides into the whole import graph for free. `tests/config/public-share-assets.test.ts` pins this.
- **An auth rejection must never be storable.** `res.redirect()` sets no cache headers, so a `302 → /login` for a `.js` path is indistinguishable from a cacheable static response. Every rejection goes through `denyCaching()` ([auth.ts](src/web/middleware/auth.ts)).

That pair is what turned a four-minute bug into a day-long outage: `lib/mobile-rows.js` was missing from `PUBLIC_SHARE_ASSETS`, Cloudflare cached the redirect against the bare URL ~4 minutes before the fix deployed, and every public share link rendered blank for the next 18 hours while the origin served the correct file the whole time. Redeploying could not clear it, because the public share page's asset URLs didn't change between builds.

**When a shipped fix "doesn't work" in prod, check the edge before re-reading the code.** `curl -sD - <url> | grep -iE 'cf-cache|age|cache-control'` — an `Age` larger than the time since deploy means you are not talking to the app.

## Project Structure

- `src/` — TypeScript source
- `dist/` — Compiled JS (committed, used by Docker)
- `src/web/public/` — Frontend (vanilla HTML/CSS/JS, no framework)
- `src/scheduler/loop.ts` — Main scan orchestrator
- `src/data/repositories/` — Database access layer (better-sqlite3)
- `src/config/` — Config from env vars, persistent settings in `data/app.env`

## Key Behaviors

- Scan interval and other runtime settings persist to `data/app.env` (mounted volume), not `.env` (container-local).
- On startup, any PENDING scan sessions from prior crashes are marked FAILED.
- Chests are written to DB in real-time during scanning. If a scan fails, all chests from that session are rolled back (deleted).
- A scan-in-progress guard prevents concurrent scans.
- Two optional phases run AFTER the scan is finalised, in this order: the daily might snapshot, then the daily Clan Capital resource-history read. Both swallow every error by design — neither may ever surface as a scan failure. See [resource-capture-phase.ts](src/scheduler/resource-capture-phase.ts).
- **Resource history is persistent (~14 days in-game); gifts are not.** A gift disappears when opened, so a missed gift is lost forever. The resource capture can always re-read, which is why it is insert-only, safe to re-run, and positioned last. Its de-duplication is an ORDERED cursor of row fingerprints, not row equality — migration v39 dropped the UNIQUE key because a player really can send the same amount twice a day. What makes the cursor sound is that two *adjacent* rows are never identical (0 exceptions in 5,873 measured adjacencies). Full reasoning in [resource-history-capture.ts](src/browser/resource-history-capture.ts).
- **The day the game is still writing to is volatile, and is never written or anchored on.** On the current account-calendar day a player's contributions merge into one line: the amount grows through the day and the merged line moves back up the list. Settled days do not move — 250 of 253 rows re-read byte-identical with **zero** changed amounts, against 20% of open-day rows vanishing from their slot by the next run. So the sweep defers the leading open block entirely: **a game day is written exactly once, in full, by the first run after it closes**, and the cursor anchors on the newest *settled* row (`buildCursorFingerprints` in [resource-sweep-rules.ts](src/browser/resource-sweep-rules.ts)). Today's donations therefore appear a run late. That is the deal, not a bug.
  - This replaced anchoring on `slice(0, 12)` — the top of the list, i.e. the twelve most volatile rows in it. The marker evaporated roughly weekly (clan 1 batches 87, 97, 109, 133, 145, 153, 157), and each loss re-read and re-inserted days already held: 809 duplicate rows and 317 stale partials, ~19% of that clan's table. `scripts/dedupe-resource-transactions.mjs` cleans up the exact duplicates (dry-run by default) and reports the stale partials rather than guessing at them.
  - **"The game merges same-day repeats into one line" is false as a general rule** and is worth un-learning: on a *settled* day a player holds several separate lines for one resource in 33% of Scientific Tractates groups. Merging happens only on the open day. Believing the strong version is what made the old anchor look safe.
- **The marker only advances after a stop that actually read the ground below it** — `cursor`, `end-of-list` or `date-floor` (`ANCHOR_SAFE_STOP_REASONS`). After `blank`, `crashed`, `page-limit`, `no-new-rows` or `error` the previous marker is kept, because those stop with unread rows still below the new anchor and advancing over them puts them under every future cut permanently. The re-read that costs is free: `withholdAlreadyRecorded` declines any row the clan already holds, keyed by multiplicity (read *m*, hold *n*, insert *m−n*) so genuine same-day repeats survive. **Deleting a scan batch clears the cursor** ([resources.ts](src/web/routes/resources.ts)) — otherwise the next run stops at a marker standing over rows that no longer exist in the DB but are still in the game.
- **The game adds resources, and a missing one is silent.** Its rows just land unresolved, indistinguishable from a bad read — Religious Tractates (v67) had been accumulating for over a week before anyone noticed. Adding one is two halves and BOTH are needed: a migration seeding `resource_types` (name + slug, mirroring v38), and `assets/resource-icons/<slug>.png`, without which the NCC pass can never match it and the migration only adds an option to the admin's manual dropdown. Everything else — the dashboards, the Totals matrix, the icon in the UI — keys off `listResourceTypes()` and the served `assets/` dir, so nothing more is wired by hand. The template's source is the catch: `data/screenshots/IMG_76*` are the "Select a resource" modal and predate anything added since, so the only image of the icon is an unresolved-row evidence crop. [extract-icon-from-row-crop.mjs](scripts/extract-icon-from-row-crop.mjs) cuts one from that, and its header explains why the highlight rectangle has to be removed by row geometry rather than by colour.
- **The game day is 17:00 UTC everywhere EXCEPT the Clan Capital history list, whose "TODAY / YESTERDAY" headers are a calendar day on the game ACCOUNT's clock.** No hour is ever exposed, so a row's true position relative to the reset is unrecoverable and that label is the only date it will ever have. Rows near the boundary therefore land on the game day next to the one they belong to. **This is accepted, not a bug to fix** — a per-clan account timezone was built and removed again (v64 → v65) because the most it could buy was moving a handful of rows a day between adjacent dates, for a settings field every clan has to be told the right answer for. The guarantee is only that every row lands on exactly one real game day. Don't re-litigate it without new information; don't reintroduce a knob.
- **A resource sweep normally stops on the cursor, not on the day label** — `findCursorIndex`: 12 stored fingerprints, matched by scored alignment (≥4 rows, 60% of a longer window, gaps tolerated, and an unresolved resource on either side wildcards). `oldest row read was labelled "…"` in the logs describes coverage, not that stop condition; it has been misread as one. Because the anchor date is re-derived per page, a sweep that crosses the rollover re-anchors and ages its carried label rather than mis-dating the tail — which also prevents a duplicate insert, since `sweepRowKey` includes the date.
- **The one place the day label IS a stop condition is the `date-floor` backstop**, added after a clan-1 daily run swept ten days it already held because the cursor didn't re-find itself. With a cursor supplied, the sweep also stops once it reads past `maxDaysBackFor(marker age)` = `age + 1 + 2` (`REREAD_OPEN_DAY_DAYS` for the settled day the anchor now sits behind, `DATE_BACKSTOP_MARGIN_DAYS` for the account-calendar labels drifting either side of the 17:00 UTC game day). **Marker age comes from `resource_capture_cursor.newest_date`, not `game_date`** — the latter is only the once-a-day gate and advances even on a run that could not move the marker, so sizing from it would stop the sweep short of the very marker it is hunting. It is always a symptom, never a clean ending — the cursor is what should have stopped it — so it warns with `describeCursorNearMiss`, which says whether the marker rows nearly aligned (match rule too strict) or barely aligned at all (they are genuinely gone). Never armed without a cursor, so a first run, a full backfill and a dry run still read the whole visible list.

## Database schema

- **One consolidated baseline, not a migration history.** `MIGRATIONS` in [database.ts](src/data/database.ts) holds a single entry at **version 72**: the `sqlite_master` output of a database built by running every historical migration, with `IF NOT EXISTS` on each statement. The second such consolidation — the first folded D1 → D30 — done once there was exactly one deployment and it was already at the head version. Nothing here rolls an older database forward; one that predates the baseline has to be walked up under an older release first.
- **A migration's SEED DATA is part of the schema.** Squashing schema-only would have produced a fresh install with an empty `resource_types` table, which fails invisibly (an unknown resource lands unresolved and reads as a bad OCR pass). The baseline's `run` reseeds the resource types and takes triumphal values from `TRIUMPHAL_PACKAGE_POINTS` rather than a copied list, so code and seed cannot drift.
- **To change the schema, append a new entry at version 73 or higher.** The runner compares against `MAX(version)`, so an existing database applies only what comes after the baseline. Then regenerate the snapshot: `npm run build && node scripts/update-schema-baseline.mjs`, and commit the fixture with the migration.
- **`tests/data/schema-baseline.test.ts` is what keeps the baseline honest.** It builds a fresh database and compares it against `tests/fixtures/schema-baseline.json`. The previous baseline was captured at v30 and went stale across forty migrations without anything noticing — a bootstrap block only ever executes on a database nobody creates, so nothing ever ran it to find out. A schema change is now a reviewable diff instead of silent drift.

## Chest identity

Chest *records* are keyed properly: `chest_records.chest_id` → `chests.id`, so a rename never loses data. What is keyed by **name** is the configuration layer, and that is where renames bite:

- `src/config/event-catalog.ts` literals, `source_point_overrides.chest_name` / `.source_key`, `chest_type_overrides.chest_name`, `triumphal_chest_points.chest_name`, `merge_rules.from_value` / `.to_value`.
- The game exposes **no chest id** — everything arrives as an OCR'd string — and `chests.id` is a per-install autoincrement that a committed source file can't reference. So a name is the only possible entry point; the fix is never "use ids in the catalog", it's that a stranded name must not be silent.
- Every one of those surfaces fails identically: **a zero that reads like a result.** That is why the Ragnarok/Jörmungandr rename went unnoticed for weeks.

Three things now stand in the way, in order of when they fire:

1. `tests/config/event-catalog.test.ts` asserts `correctChestName(name) === name` for every declared chest. `cleanupChestNames` reconciles `chests` through that function on every boot, so a name it would rewrite is one no row can hold. Runs as part of `npm run build`.
2. `resolvePredicate` ([event-repo.ts](src/data/repositories/event-repo.ts)) resolves exact → corrected → accent-folded, so a stale literal still gets the right number, and flags itself on the page and in the log instead of dropping the rule.
3. `checkConfigIntegrity` ([config-integrity.ts](src/data/config-integrity.ts)) sweeps every name-keyed table at boot. Errors light the System nav dot; warnings are `noAlert`. Returns nothing on a database with no chest records — a fresh install has an empty `chests` table and pre-declaring a chest is supported.

`cleanupChestNames` must carry a rename into all four config tables. For `merge_rules` only `to_value` moves — `from_value` is the bad spelling the rule exists to catch, and repointing it deletes the rule as a self-loop.

## Browsers

Two Chromium instances, each with its own persistent profile per clan (see [clan-paths.ts](src/config/clan-paths.ts)) — never share a profile dir, Playwright can't open one twice.

- **Scanner** — [src/browser/launcher.ts](src/browser/launcher.ts), headless.
- **Login bridge** — [src/web/login-bridge.ts](src/web/login-bridge.ts): an interactive session streamed to the admin UI over a WebSocket, used both to sign a clan in (email + password) and for several admins to operate the shared game account. **Full reference: [docs/login-bridge.md](docs/login-bridge.md)** — read it before changing the bridge.

Both launch through the shared GPU recipe in [src/browser/gpu.ts](src/browser/gpu.ts) and the profile-lock cleanup in [src/browser/profile-lock.ts](src/browser/profile-lock.ts). Things worth knowing before touching either:

- **`channel: 'chromium'` selects Chromium's NEW headless** (a full browser rendering offscreen). The default `headless: true` uses `chromium-headless-shell`, which has **zero GPU support** and is feature-poor. New headless is also what replaced the bridge's old headed-under-Xvfb setup — Xvfb is a software framebuffer and can never be GPU-accelerated.
- **A broken GPU path does not error — WebGL context creation never completes.** Anything that needs a context (i.e. the game) then hangs. Always verify with `logWebglRenderer()` before navigating somewhere heavy, and keep the timeout on it.
- **Env toggles are only visible to the process if they're in `docker-compose.yml`'s `environment:` list.** Compose uses `.env` for `${...}` interpolation inside the file, not to pass variables into the container. A new toggle that isn't listed there silently does nothing.
- **Clear stale Chromium singleton locks before launching.** They survive an unclean exit in the mounted volume, and since Docker assigns a new container hostname on every recreate, Chromium refuses to break them — turning one hard kill into a permanent crash loop. `fs.existsSync()` cannot see them: they're dangling symlinks.
- **Playwright puts NO timeout on input or `page.evaluate()`.** `timeout` isn't merely defaulted off — it doesn't exist in the wire schema for `mouse.*` / `keyboard.*` / `evaluate`, so no timer is ever armed and a renderer that is alive but wedged parks the caller forever. Always go through the bounded wrappers in [input.ts](src/browser/input.ts) / `withDeadline` ([deadline.ts](src/utils/deadline.ts)); never call `page.mouse.*` or `page.keyboard.*` directly.

## Wedged-browser liveness

A scan on 2026-08-04 ran 4h59m37s (58 batches at ~310s against a healthy ~4s), blocked both clans behind the scan-in-progress guard, and had to be killed by hand. The host — not this container, whose cgroup sat at 914MB of a 5120MB ceiling — was out of memory and the kernel was OOM-killing Chromium's children. **`memory.events`' `oom_kill` counts kills by ANY OOM killer, so a rising count next to a healthy `memory.current` means the LXC is starved, not the container.** Raising `MEMORY_LIMIT` cannot help that.

Three bounds keep it from recurring, and they are layered on purpose:

- **Per-call deadlines** (`input.ts`) catch a call that never returns. Necessary, but a browser answering everything 80× slow violates no per-call deadline.
- **A throughput guard** in [scan-pipeline.ts](src/scheduler/scan-pipeline.ts) — 3 consecutive batches over 60s, a 45-min capture budget, or any `oom_kill` during the sweep — abandons the capture phase. This is what actually caught the incident's failure mode.
- **The OCR phase is deliberately exempt** from both. Its crops represent chests already *claimed* in-game, so abandoning one is unrecoverable loss where abandoning a capture batch only postpones chests still sitting on the Gifts tab. It also touches no browser.

**Do not "fix" the missing OCR timeout.** `onnxruntime-node`'s `run()` is a synchronous native call behind a cosmetic `setImmediate`, so it holds the event loop for its whole duration — which is also why the admin UI goes dead during a scan rather than reporting a stuck one. A `Promise.race` around it can never fire: the timer cannot run while the thread is inside the inference. Measuring the batch afterwards is the only bound available short of moving OCR to a worker thread.

## Logging

- `log.warn`/`log.error` land in a **20-entry** ring buffer surfaced on the System page ([log-buffer.ts](src/utils/log-buffer.ts)). A burst of repeated warnings evicts everything else, so anything on a hot path must coalesce via [log-throttle.ts](src/utils/log-throttle.ts) (one immediate line + one `repeated N×` summary per window).
- Pass `log.warn({ noAlert: true }, ...)` for informational warnings that shouldn't light the System nav dot.
