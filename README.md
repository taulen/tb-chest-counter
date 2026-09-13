# TB Chest Counter

A self-hosted tracker for **Total Battle** clan gift chests. It drives the game
in a headless browser, reads the Gifts tabs with on-device OCR, scores each
chest, and serves a multi-clan web dashboard and Discord bot. No game API, no
cloud AI — everything runs locally in one container.

> **Two things to know before you install it.**
>
> **It signs in as you and clicks for you.** There is no API; the only way to
> read your clan's gifts is to open the game and look at it. Automating a game
> client may conflict with Total Battle's terms of service, and that risk falls
> on the account you point it at. Not affiliated with Total Battle or
> Scorewarrior.
>
> **It needs a one-time calibration.** The game is a WebGL canvas with no DOM to
> query, so the scanner is taught where to click by having you mark points on a
> screenshot of *your* game. Four short stages, walked through in the browser.
> See [First-run setup](#first-run-setup).

## Requirements

- **Linux host with Docker.** The image is Linux-only by design (the build
  strips the OCR runtime's non-Linux binaries to save ~220MB). Local
  development works on any OS.
- **~5GB RAM for the container.** Chromium's WebGL usage is the driver, not the
  database. Give it real headroom — the default `MEMORY_LIMIT` is `5g`.
- **2-4 CPU cores.** Software rendering of the game is per-pixel work; see
  [GPU acceleration](#gpu-acceleration-and-the-software-fallback) for how to
  hand that to an integrated GPU instead.
- **A Total Battle account that is in the clan you want to track**, with the
  Gifts tab visible to it.
- **Optional:** an Intel/AMD integrated GPU exposed at `/dev/dri`, a Discord
  bot token (per clan, configured in-app).

## Features

- **Automated scanning** — a headless **Chromium** (bundled via Playwright)
  logs into the game, opens the Gifts and Triumphal Gifts tabs, and captures
  every gift on a timer (default every 120 minutes).
- **On-device OCR** — local, no external API:
  - **PaddleOCR** (PP-OCRv6 via ONNX Runtime).
  - **Non-Latin fallback** re-reads Cyrillic/Arabic player names with bundled
    PP-OCRv5 language models.
- **Resource tracking** — record what members send by uploading screenshots of
  the in-game resource-sending history; the same OCR pipeline reads each row.
- **Multi-clan / multi-user** — one instance tracks many clans, each with its
  own game login, roster, Discord bot, and scoring. App accounts come in three
  roles: `superadmin` (cross-clan), `admin` (one clan), `user` (one clan,
  read-only).
- **Web dashboard** — leaderboard, analytics, member pages, events, resources,
  scan history, and admin/clan/user management. Light / Dark / OLED themes.
- **Public share links** — expose a read-only leaderboard at `/<token>` with no
  login required.
- **Discord bot** — per-clan `/leaderboard` and `/status` commands, automated
  scan reports, and a scheduled daily digest.
- **ChestTracker integration** — optionally ingest snapshots from
  chesttracker.com per clan.
- **Event calendar** — the Events page reads the Total Battle event schedule
  from the public **tbclanportal.com** iCal feed (`/calendar/feed.ics`) to drive
  per-occurrence timeframes (one event run = one selectable window) and a "next
  occurrence" tag per event. Read-only and cached; degrades to a fixed
  Weekly/Monthly selector if the feed is unavailable.
- **SQLite storage** — a single `better-sqlite3` database tracks members,
  chests, sources, points, sessions, users, and clans.

## How it works

```
Total Battle (Unity/WebGL canvas game)
        │  headless Chromium (Playwright), one browser per clan, scanned serially
        ▼
  Screenshot capture of the Gifts / Triumphal Gifts tabs
        ▼
  OCR (PaddleOCR default, Tesseract fallback)  ──►  fuzzy-match names to the captured roster
        ▼
  Scoring (source + chest name → points)
        ▼
  SQLite (better-sqlite3)
        ▼
  Web dashboard  +  Discord bot  +  public share links
```

The game canvas has no DOM to query, so navigation and scanning rely on
**operator-calibrated screen coordinates** (set once per install from the
System page), not on element selectors or vision-based UI detection.

## Deployment (Docker)

This is the primary way to run it — designed for Docker Compose / Portainer
stack-from-git.

```bash
# 1. Compile TypeScript (the image runs pre-built dist/, which is committed)
npx tsc

# 2. Build and start
docker compose up -d --build
```

Then open the dashboard at **`http://<host>:3010`** (host `3010` → container
`3000`) and complete the web setup (below).

Key deployment facts:

- **Base image:** `node:22-slim`. The image is **Linux-only** (see
  [CLAUDE.md](CLAUDE.md) — the build strips non-Linux OCR binaries to save
  ~220 MB).
- **`dist/` is committed and copied into the image — there is no build step in
  the Dockerfile.** Always run `npx tsc` and commit `dist/` before deploying,
  or the container runs stale code.
- **Volume:** `tb-chest-data` → `/app/data` holds everything persistent: the
  SQLite DB, screenshots, per-clan auth (`data/clans/<id>/`), runtime settings
  (`data/app.env`), and gzip backups.
- **Resources:** memory limit `5g`, CPU reservation `2` (override with
  `MEMORY_LIMIT` / `CPU_RESERVATION`). The browser's WebGL usage is the memory
  driver, so give the container real headroom.
- **Deploy verification:** `GET /api/health` (public) returns `builtAt` and a
  `fingerprint` hashed over `dist/` + `src/web/public/`. The dashboard footer
  shows the same. If they don't change after a redeploy, the rebuild didn't
  take (a cached layer was served).

## First-run setup

Setup runs entirely in the browser.

1. On first boot (no `data/app.env` and no existing DB), the app starts in
   **setup mode** and blocks until setup completes. Open
   `http://<host>:3010/setup`.
2. Create the first **superadmin** account. You're logged in automatically.
   Database path, web port and scan interval are not asked for — they start on
   their defaults and are editable from the System page afterwards.
3. On the same page, use the embedded **login bridge** (below) to sign the app
   into Total Battle for your first clan.
4. Once a valid game session is captured, the app switches to normal mode in
   the same process (no restart).

Calibration and roster capture are done afterward from the running dashboard
(System → calibration wizard; then the clan's onboarding capture), not during
setup.

### Restoring an existing install instead

The wizard's second tab takes a `.db` / `.db.gz` backup and adopts it as this
install's database — clans, members, chest history, scoring, and every user
account including superadmins. An older backup is migrated forward on the way
in. Sign in afterwards with the credentials from that backup; the wizard issues
no session of its own, because the accounts are the backup's.

A backup carries no Total Battle session (those live on disk per clan, not in
the DB), so after restoring, run the login bridge once per clan from the Clans
page. A backup with no superadmin is refused — by the time it were live, the
setup window would have closed on an install nobody can sign in to.

### Running a second instance

Only needed if you want a scratch deployment beside a live one — to try the
first-run flow against a blank database, say. Skip this on a first install.

Give it its own Compose project, container name, port and volume — all four:

```bash
INSTANCE_NAME=tb-chest-counter-scratch DATA_VOLUME=tb-chest-data-scratch \
  HOST_WEB_PORT=3011 docker compose -p tbcc-scratch up -d --build
```

Each one is load-bearing, and they fail differently:

- **`DATA_VOLUME`** is the one that matters most. Share the live volume and the
  new container adopts the existing database and `app.env`, so it boots
  straight past setup — silently testing nothing.
- **`INSTANCE_NAME`** is needed because `container_name` is a fixed name, and
  two containers on a host cannot share one. Without it the second stack fails
  outright with a name conflict.
- **`-p`** keeps the two stacks' Compose bookkeeping apart, so `down -v` on one
  can never reach the other's data.
- **`HOST_WEB_PORT`** avoids the port clash on 3010.

> On a platform that **ignores** `container_name` — Portainer deploying to
> Swarm, or anything that scales the service — `INSTANCE_NAME` does nothing,
> and containers are named `<project>-app-1` from the stack name instead. If
> you see a name like `mystack-app-1` where you expected yours, that is what
> happened, and the stack name is the knob that matters.

### Re-running setup

`needsSetup()` is false as soon as `data/app.env` **or** the database file
exists, and both live on the mounted volume — so a half-finished setup (account
created, game sign-in not done) leaves the wizard permanently "already
complete". To get back to a genuine first run:

```bash
docker exec <container> node scripts/reset-setup.mjs --yes   # add --all to also
docker restart <container>                                   # clear clan profiles
```

It renames the database and profile dirs aside with a timestamp rather than
deleting them (and prints the `mv` commands to undo), removes the two env
files, and needs `--yes` — run it with no flags for a dry run. Locally:
`npm run reset-setup -- --yes`.

### Logging the app into Total Battle (the login bridge)

The app runs a Chromium instance server-side and **streams it into your browser
over a WebSocket** — you drive the real game login inside the dashboard, with
your mouse and keyboard relayed to it, and the captured session is saved
server-side. Several admins can share the one session, which is also how a clan
with shared account credentials operates it.

- Start it from **Setup** (first clan) or **Clans → Refresh login** (any clan,
  e.g. after a re-auth prompt).
- The session is stored per clan at `data/clans/<id>/storage-state.json`; the
  previous one is backed up to `.bak` on each save.
- It runs **Chromium's new headless mode** (`channel: 'chromium'`) — a full
  browser rendering offscreen, not the feature-poor `headless-shell`. That is
  what lets it reach the GPU at all; the old headed-under-Xvfb setup could not,
  because Xvfb is a software framebuffer. `LOGIN_BRIDGE_DISPLAY=xvfb` still
  exists as an escape hatch.
- Sessions auto-tear-down after 3 min idle or 30 min absolute.
- Full reference: [docs/login-bridge.md](docs/login-bridge.md).

When a saved session stops working, the scan's auth check flags the clan as
**needs re-auth** (dashboard badge + one-shot Discord ping); re-run the bridge
to fix it.

## GPU acceleration and the software fallback

The scanner renders a WebGL game. By default it does that **on the CPU**, which
works everywhere and is the reason the container wants several cores.

Handing it to an integrated GPU cuts that dramatically:

```yaml
# docker-compose.yml
environment:
  - SCANNER_GPU=1          # scanner renders on the iGPU (ANGLE + Vulkan)
  - LOGIN_BRIDGE_GPU=      # unset follows SCANNER_GPU; 0/1 to decide separately
devices:
  - /dev/dri:/dev/dri      # must exist on the host, renderD128 world-readable
```

Host setup (Proxmox → LXC → Docker included) is in
[docs/igpu-passthrough.md](docs/igpu-passthrough.md).

**If you have no GPU, change nothing.** `SCANNER_GPU=0` is the default and the
software path is fully supported — it is slower, not degraded. Comment out the
`devices:` block if `/dev/dri` does not exist on your host, or the container
will refuse to start.

Two things worth knowing before you turn it on:

- **A broken GPU path does not error — it hangs.** WebGL context creation never
  completes, so anything that needs a context (i.e. the game) waits forever.
  The app probes the renderer with a timeout before navigating anywhere heavy,
  logs what it got, and **falls back to software rendering by itself** if the
  context never arrives. If scans suddenly take forever after enabling this,
  check the log for the renderer line.
- **Environment variables only reach the container if they are listed in
  `docker-compose.yml`'s `environment:` block.** Compose uses `.env` for
  `${...}` interpolation *inside the file*, not to pass variables through. A
  new toggle that isn't listed there silently does nothing.

Lowering `LOGIN_BRIDGE_VIEWPORT` (default `1280x800`) is the other lever: on
the CPU, rendering cost is per-pixel, so `960x600` is ~45% less work for a
softer picture.

## Troubleshooting

**A scan never finishes, or the dashboard goes unresponsive during one.**
OCR is a synchronous native call that holds the event loop for its duration —
the UI going quiet mid-scan is expected, not a hang. A genuinely wedged browser
is caught by the throughput guard (3 consecutive batches over 60s, a 45-minute
capture budget, or an OOM kill) and the capture phase is abandoned.

**Scans stop with "Members tab not visible" or find no gifts.**
Usually the game is showing something over the UI — a store offer or event popup
that Escape does not close. The capture reloads the game once and retries, and
says so in the log. If it persists, open the login bridge and close the popup by
hand once.

**The roster is short, or a member never appears.**
The member sweep reports what it saw: `page N: 5 coord row(s) → 4 name(s)`, and
a closing line with rows seen versus names kept. If rows were seen and not kept,
it is OCR; if the sweep hit its page ceiling, it warns.

**Might tracking reads nothing.**
It is gated on Stage 4 having been re-saved with the might column *inside* the
rectangle. Re-run Stage 4 and drag the right edge past the number beside the
shield icon.

**A fix deployed but production still misbehaves.**
If you put a CDN in front of this, check the edge before re-reading the code —
`curl -sD - <url> | grep -iE 'cf-cache|age|cache-control'`. An `Age` larger than
the time since deploy means you are not talking to the app.

**The container is being OOM-killed but its memory use looks fine.**
`memory.events`' `oom_kill` counts kills by *any* OOM killer. A rising count
next to a healthy `memory.current` means the host is starved, not the
container, and raising `MEMORY_LIMIT` cannot help.

## Multi-clan model

- Each clan is a row in the `clans` table with its own storage dirs under
  `data/clans/<id>/`, Discord settings, ChestTracker settings, public-share
  token, optional per-clan scan interval, and active/needs-reauth status.
- The game URL is **not** per-clan — all clans use the same
  `https://totalbattle.com`; you switch clans **inside the game canvas** during
  the login bridge. Isolation is at the cookie/profile layer only.
- **Roles:** `superadmin` (no clan, sees/manages all clans and users), `admin`
  (manages one clan's content, config, users, and scans), `user` (read-only
  member of one clan).
- Superadmins add clans (`Clans` tab) and switch the active clan from the
  header; per-clan config routes require clan **ownership + admin**, so a plain
  member can't change a Discord token or trigger scans.

## Web dashboard

Pages are role-gated. Members see:

- **Dashboard** — live scan status, next-scan countdown, headline stats, clan
  records.
- **Analytics** — daily-activity charts, chest-type breakdown, top-contributor
  podiums, source breakdown, and a drill-down "all chest types" table.
- **Leaderboard** — daily / weekly / monthly / yearly / all-time, with
  period stepping, sorting, and pagination.
- **Members** — sortable roster plus per-member detail (rank, week-over-week
  progress, single-day records, full chest history).
- **Events** — per-event chest breakdowns per player.
- **Triumphal Chests** — separate leaderboard/history for triumphal chests
  (tracked but **never scored**).
- **Resources** *(if enabled for the clan)* — per-resource totals and charts of
  what members have sent. Unlike chests, resource data is entered **manually**:
  on the admin sub-tab you upload screenshots of the in-game resource-sending
  history, and the OCR pipeline extracts each row (member, resource, send/
  receive, amount, date). Members see read-only Overview / Totals tabs.
- **Scan History** — recent scan sessions and the chests each captured.
- **ChestTracker** *(if enabled)* — chesttracker.com snapshots and deltas.

Admins additionally get **Admin** (merge players/chests/sources, source-point
overrides, review queue, OCR name reassignment, recalculate points), **Clans**,
and **Users** (CRUD + audit log). Superadmins get **System** (scan interval,
debug/raw-OCR toggles, calibration wizard, backup/restore, container restart,
log viewer).

## Discord bot

Configured **per clan from the Clans page** (token, channel, guild, toggles) —
not via environment variables. Clans sharing a token share one gateway
connection.

- **`/leaderboard [period]`** — `daily | weekly | monthly | all` (default
  weekly).
- **`/status`** — scanner status and totals.

Commands are locked to the one configured channel. The bot also posts scan
reports and a scheduled **daily digest** (with an optional DM of "top crypters"
text formatted for pasting into in-game chat). Leaderboard tables are sent as
plain-message **code blocks**, not embeds, because embeds are too narrow.

## Configuration

Config comes from two layers, loaded in order (later wins):

1. **`.env`** — boot-time operator config. Copy [.env.example](.env.example),
   which is the accurate, up-to-date template.
2. **`data/app.env`** — runtime settings the app writes itself (on the mounted
   volume). Anything you change in the dashboard (scan interval, calibration,
   debug toggles) is persisted here, never to `.env`, and applies without a
   restart.

The authoritative list of variables is [.env.example](.env.example) and
[src/config/schema.ts](src/config/schema.ts). Most-used:

```env
SCAN_NON_LATIN_FALLBACK=true    # re-OCR Cyrillic/Arabic player names
SCAN_INTERVAL_MS=7200000        # 120 min (runtime-adjustable in the UI)
HEADLESS=true
WEB_PORT=3000                   # container port; host maps 3010 -> 3000
GAME_DAY_ROLLOVER_UTC_HOUR=17   # in-game day boundary (see below)
DB_PATH=./data/tb-chests.db
LOG_LEVEL=info
# Events schedule source (public iCal feed). Override only to self-host a mirror.
EVENT_CALENDAR_ICS_URL=https://tbclanportal.com/calendar/feed.ics
```

Compose-level knobs: `HOST_WEB_PORT` (default `3010`), `NODE_MAX_OLD_SPACE_MB`
(`4096`), `MEMORY_LIMIT` (`5g`), `CPU_RESERVATION` (`2`), plus `INSTANCE_NAME`
(`tb-chest-counter`) and `DATA_VOLUME` (`tb-chest-data`) for running a second
instance alongside the live one (see Deployment above).

> **Note:** OCR runs on-device (PaddleOCR) — there is no `VISION_PROVIDER` var
> and no cloud-vision API keys. Discord and scoring are configured in-app, not
> via env vars.

## Scoring & game day

- **Points** come from a **global** scoring table (managed by superadmins,
  shared across all clans). Each chest's value is looked up by
  `(source, chest name)` with precedence: exact override → source wildcard →
  built-in default. Editing an override backfills historical records.
- **Game-day rollover** is a fixed UTC hour (**default 17:00 UTC**, not
  midnight). Daily/weekly/monthly periods and the Discord daily digest all snap
  to this boundary so they match the game's day.

## Data tracked

Per gift entry: player name (with a secondary English/transliterated pass),
chest name, chest rarity/type, source (e.g. "Level 20 Citadel", "Bank"), gift
tab, quantity, capture time, confidence, and the resolved member + point value.
Triumphal gifts are recorded separately and never contribute points.

## Development

```bash
npm install
npm run dev        # tsx watch on src/index.ts
npm run build      # tsc -> dist/  (commit dist/ before deploying)
npm start          # run compiled dist/index.js
npm run typecheck  # tsc --noEmit (app + tests)
npm run test:run   # vitest
```

- **Source:** `src/` (TypeScript). **Compiled output:** `dist/` (committed, run
  by Docker). **Frontend:** `src/web/public/` (vanilla HTML/CSS/JS, copied
  as-is).
- **Database:** single `better-sqlite3` file (`data/tb-chests.db`, WAL mode)
  holding chest, resource, ChestTracker, user, and clan data. Migrations run
  automatically on boot. Daily gzip backups land in `data/backups/`.

See [CLAUDE.md](CLAUDE.md) for build/deploy conventions and the reasoning
behind the parts that look odd, and [CONTRIBUTING.md](CONTRIBUTING.md) if you
plan to send a patch.

## Security

Please read [SECURITY.md](SECURITY.md) before exposing this to anything. Short
version: it holds a live game session and other people's data, it is built for a
trusted network rather than the open internet, and vulnerabilities should go to
a private advisory rather than a public issue.

## Licence

[MIT](LICENSE). Not affiliated with, endorsed by, or connected to Total Battle
or Scorewarrior; all game names and assets belong to their owners.
