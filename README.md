# TB Chest Counter

A self-hosted tracker for **Total Battle** clans. It reads your clan straight
from the game's own servers — gifts, members, might, research, the Clan Capital
ledger — opens the clan's chests, scores them, and serves a multi-clan web
dashboard and Discord bot. No screen-reading, no cloud services: everything
runs in one container.

> **Know this before you install it.**
>
> **It signs in as you.** Each scan signs into the game with the account you
> point it at, the same way the web client does, and opens that clan's gifts.
> A scan takes the account's game session over for a few seconds, so anyone
> playing on that account at that moment is signed out of the game. Automating
> a game client may conflict with Total Battle's terms of service, and that risk
> falls on the account you use. Not affiliated with Total Battle or Scorewarrior.

## Requirements

- **Linux host with Docker.** The image is Linux-only by design; local
  development works on any OS.
- **Memory:** the default `MEMORY_LIMIT` is `5g`. The login bridge's browser is
  the heaviest part, and only runs while someone is signing a clan in.
- **A Total Battle account that is in the clan you want to track**, with access
  to the clan's Gifts. The scanner opens the clan's gifts with this account.
- **Optional:** a Discord bot token (per clan, configured in-app).

## Features

- **Scanning from the game itself** — every scan reads the clan's gift list
  (Gifts and Triumphal Gifts) from the game server, records each chest with its
  exact sender, chest, source and arrival time, then opens it with the game's
  own claim request and keeps what it gave. A whole clan takes seconds, so the
  interval can be short (default every 120 minutes).
- **Nothing to calibrate, nothing to misread** — names come from the game's
  data, not from pictures of it. Every chest and every member carries the game's
  own id, so renames follow the player and nothing is counted twice.
- **Per-clan scoring** — every clan sets its own chest point values on the
  Chest Points board, can copy another clan's values, and can value sources
  that haven't dropped yet. Values have a history: a change applies from today
  on or to all of history. Triumphal chests score separately, from their
  package value.
- **Members kept in sync** — the roster, clan roles, join dates and in-game
  renames come from the game every scan. Anyone no longer in the clan is
  removed automatically (kept in history, restorable), and comes back as the
  same member if they rejoin.
- **Might tracking** — every member's might and hero level each scan, with
  per-member history and a clan-wide trend.
- **Resource tracking** — the Clan Capital ledger is read every scan: what each
  member donated and what the clan paid out, one row per ledger line.
- **Troop tiers and Gold Pass from the game** — each member's G/S/E/M tiers and
  crypt level come from their research (with when each was reached), and the
  Gold Pass from their game record.
- **Events** — per-event chest breakdowns, with timeframes taken from the
  public **tbclanportal.com** event calendar (one event run = one selectable
  window). Includes Tin Man / Rise of the Ancients standings pasted per summon,
  per-tier targets and a "below target" list ready to paste into chat.
- **Tools** — an Ancient planner prefilled from the clan roster, a Citadel
  battle simulator, a stack calculator, research costs, and a reward splitter.
- **Multi-clan, multi-user** — one instance tracks many clans, each with its
  own game login, roster, Discord bot, scoring, week shape (Sunday-to-Sunday,
  or Tin Man to Tin Man) and public URL. One account can belong to several
  clans, with a separate role in each.
- **Web dashboard** — sidebar layout, Light / Dark / OLED themes (or follow the
  device), mobile-friendly tables, five languages, and the accessibility work
  described in [ACCESSIBILITY.md](ACCESSIBILITY.md).
- **Public share links** — any number of read-only leaderboard links per clan
  at `/<key>`, each with its own visit counter and an optional vanity key; no
  login required. A built-in FAQ explains the points and how to get access.
- **Discord bot** — per-clan `/leaderboard`, `/me` and `/status` commands, scan
  reports, and daily and weekly digests, optionally DM'd to chosen members as
  text ready to paste into in-game chat.
- **In-game chat digest** (opt-in per clan) — the clan's scanner account posts
  the daily "Daily Digest — Our top 20 crypters" message straight into a group
  chat the admins pick: at most one message a day, never split, never into the
  clan chat, kingdom chat or a private chat; `CHAT_SEND_DISABLED=1` switches all
  sending off. See [docs/chat-digest.md](docs/chat-digest.md).
- **ChestTracker integration** — optionally ingest snapshots from
  chesttracker.com per clan.
- **Safe to administer** — deleting a clan hides it rather than destroying it
  (restorable from the System page), a single clan can be restored out of a
  backup, and every admin action lands in an audit log.
- **SQLite storage** — a single `better-sqlite3` database, migrated
  automatically on boot, with daily gzip backups.

## What it collects

Every scan, per clan:

- **Chests** — every gift on both tabs: sender, chest, source, how many, and
  when it arrived; then the rewards each one gave when opened.
- **Members** — the game's player id, exact name, clan role and join date;
  who left and who was renamed.
- **Players** — might, hero level, city level, VIP level and Gold Pass.
- **Clan Capital ledger** — every donation and payout, by member.
- **Vaults of the Ancients** near members' cities, on the days they exist.
- **The clan itself** (My Clan page) — its logo drawn from the game's own
  layers, tag and name, members against the member limit, might, wealth
  points, help points, founding date, the medals it displays, the Clan
  Capital's position and treasury (each item with its game icon), the clan's
  research (Clan territories, Allies, Fortifications) drawn as the game's
  trees, and the kingdom's clan rankings — wealth, might, valor, conquest and
  crypts, the top 100 with logos and the clan's own rank by day — with a
  reading per scan and a history of every research level-up.

Every minute:

- **Chat** — the clan chat and the scanner account's private messages, with
  months of history read on the first sync and older history pulled a slice
  at a time until the game has nothing older. Every stored line is kept for
  good, also once the game stops serving it. The **Chats** page shows the
  clan chat (searchable, filter by writer, jump to a date, new lines live;
  shared map locations, raids, joins and reports shown as the game shows
  them). Private messages are stored but never shown.

Once a day:

- **Research and hero talents** for every member, with a history of each
  level change.
- **Captains** for every member — level, star level and the active line-up,
  with a history of each level and star — shown on the profile with the
  game's portraits, art and star bonuses.
- **Captain equipment** for every member — the item each captain wears in
  each position, its quality grade and bonuses, and the gems and enchantment
  set into it, with a history of every change.
- **Artifacts** for every member — the ones the three line-up captains wear
  (Torch of Olympus, Ghostflame Lantern…), with level, star level and random
  bonuses, and a history of each change. The archived city replies of the
  previous weeks are re-read for both, so history starts from the first
  archived read.
- **Buildings and hero** for every member's city.
- **Raw replies** — the clan record, the Clan Capital and every member's city
  — archived as received, so fields that are not decoded yet still have
  history once they are.

Some of this is collected ahead of being shown: chest rewards are on the way
to the dashboard.

Chest, item, research and hero names come from the game's public static data,
which the server downloads and caches itself when the game publishes a new
version. None of the game's data or art is stored in this repository.

## How it works

```
Saved Total Battle login (captured once per clan through the login bridge)
        │  sign in the way the web client does — one clan at a time
        ▼
Game server (binary MessagePack over HTTPS)
        │  clan record · player records · Clan Capital ledger · cities · map
        ▼
Record every gift by its game id  →  open it  →  keep its rewards
        ▼
Scoring (the clan's points for source + chest, as of the day it was earned)
        ▼
SQLite (better-sqlite3)
        ▼
Web dashboard  +  Discord bot  +  public share links
```

A gift is recorded before it is opened, and keyed by the game's gift id, so a
failed open or an interrupted scan can neither lose a chest nor count it twice:
the next scan records nothing new for it and opens it again. Protocol details:
[docs/game-protocol.md](docs/game-protocol.md).

## Deployment (Docker)

This is the primary way to run it — designed for Docker Compose / Portainer
stack-from-git.

```bash
# 1. Compile TypeScript (the image runs pre-built dist/, which is committed)
npm run build

# 2. Build and start
docker compose up -d --build
```

Then open the dashboard at **`http://<host>:3010`** (host `3010` → container
`3000`) and complete the web setup (below).

Key deployment facts:

- **Base image:** `node:22-slim`, Linux-only.
- **`dist/` is committed and copied into the image — there is no build step in
  the Dockerfile.** Always run `npm run build` and commit `dist/` before
  deploying, or the container runs stale code. CI fails any push whose
  committed `dist/` doesn't match a fresh build.
- **Volume:** `tb-chest-data` → `/app/data` holds everything persistent: the
  SQLite DB, per-clan logins (`data/clans/<id>/`), the cached game data
  (`data/game-static/`), runtime settings (`data/app.env`), and gzip backups.
- **Resources:** memory limit `5g`, CPU reservation `2` (override with
  `MEMORY_LIMIT` / `CPU_RESERVATION`).
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
4. Once a valid game login is saved, the app switches to normal mode in the
   same process (no restart).

That is all. The first scan reads the roster, the gifts and the ledger from the
game in seconds.

### Restoring an existing install instead

The wizard's second tab takes a `.db` / `.db.gz` backup and adopts it as this
install's database — clans, members, chest history, scoring, and every user
account including superadmins. An older backup is migrated forward on the way
in. Sign in afterwards with the credentials from that backup; the wizard issues
no session of its own, because the accounts are the backup's.

A backup carries no Total Battle login (those live on disk per clan, not in
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
your mouse and keyboard relayed to it, and the login is saved server-side.
Several admins can share the one session, which is also how a clan with shared
account credentials operates it.

- Start it from **Setup** (first clan) or **Clans → Refresh login** (any clan,
  e.g. after a re-auth prompt).
- The login is stored per clan at `data/clans/<id>/storage-state.json`; the
  previous one is backed up to `.bak` on each save. Scans keep it current the
  way a browser would, so it stays valid between visits.
- Sessions auto-tear-down after 3 min idle or 30 min absolute.
- To render the bridge on an integrated GPU instead of the CPU, see
  [docs/igpu-passthrough.md](docs/igpu-passthrough.md); without one, change
  nothing.
- Full reference: [docs/login-bridge.md](docs/login-bridge.md).

Every 30 minutes the app checks each clan's saved login against the website.
When one stops working, the clan is flagged **needs re-auth** (dashboard badge +
one-shot Discord ping); re-run the bridge to fix it.

## Troubleshooting

**A scan fails with "The saved Total Battle login has expired".**
The website signed that login out — usually because the account's password
changed or it was signed out everywhere. Refresh it with the login bridge
(Clans → Refresh login). Nothing was recorded or opened by the failed scan.

**A scan fails with "Could not read the clan from the game".**
The game servers were unreachable or in maintenance. Nothing was opened, and
the next scan picks everything up — gifts stay in the game for about 20 hours.

**Someone playing on the scanner account keeps getting signed out.**
Each scan takes the account's game session over for a few seconds. Use an
account nobody plays on at scan time, or lengthen the scan interval.

**A fix deployed but production still misbehaves.**
If you put a CDN in front of this, check the edge before re-reading the code —
`curl -sD - <url> | grep -iE 'cf-cache|age|cache-control'`. An `Age` larger than
the time since deploy means you are not talking to the app.

## Multi-clan model

- Each clan is a row in the `clans` table with its own storage dirs under
  `data/clans/<id>/`, Discord settings, ChestTracker settings, share links,
  chest point values, optional scan interval, week shape, public URL, and
  active/needs-reauth status.
- Every clan is scanned through its own saved login, one clan at a time. One
  website account may hold logins for several clans.
- **Roles:** `superadmin` (no clan, sees/manages all clans and users), `admin`
  (manages a clan's content, config, users, and scans), `user` (read-only
  member of a clan).
- **An account can belong to several clans.** It has a home clan, and a
  superadmin can grant it others from **Users → Clans**, with a separate role
  in each (admin in one, plain user in another). It then switches between them
  from the header, like a superadmin does. While viewing a clan it has exactly
  that clan's role and reaches nothing in any other; other clans' admins see it
  as a guest and are never told where else it belongs. Details:
  [docs/multi-clan-accounts.md](docs/multi-clan-accounts.md).
- Superadmins add clans (`Clans` tab) and switch the active clan from the
  header; per-clan config routes require clan **ownership + admin**, so a plain
  member can't change a Discord token or trigger scans.
- **Deleting a clan is a soft delete.** The clan disappears everywhere but
  every row stays, and the System page brings it back.

## Web dashboard

Pages are role-gated. Members see:

- **Dashboard** — live scan status, next-scan countdown, headline stats, clan
  records.
- **Analytics** — daily-activity charts, chest-type breakdown, top-contributor
  podiums, source breakdown, and a drill-down "all chest types" table, all for a
  selectable timeframe.
- **Leaderboard** — daily / weekly / monthly / yearly / all-time, with
  period stepping, sorting, pagination, and an FAQ of points per chest.
- **Members** — sortable roster plus per-member detail (rank, week-over-week
  progress, single-day records, guards level, Gold Pass, full chest history).
- **Events** — per-event chest breakdowns per player for each event run, plus
  Tin Man / Ancients standings and targets.
- **Triumphal Chests** — separate leaderboard/history for triumphal chests,
  scored from their package value and kept **out of the main leaderboard**.
- **Might** — every member's might and hero level, the clan's might over time,
  and side-by-side member comparison.
- **Resources** — per-resource totals and charts of what members have sent and
  received, from the Clan Capital ledger every scan reads. Members see
  read-only Overview / Totals tabs; admins also get the editable ledger.
- **Tools** — the Ancient planner, Citadel simulator, stack calculator,
  research costs and reward splitter.
- **Scan History** — recent scan sessions and the chests each recorded.
- **ChestTracker** *(if enabled)* — chesttracker.com snapshots and deltas.

Admins additionally get **Admin** (the Chest Points board, merge
players/chests/sources, review queue, player levels imported from chat),
**Clans** (Discord, share links, login bridge, clan settings), and **Users**
(accounts + audit log). Superadmins get **System** (scan interval, event
schedule corrections, backup/restore including single-clan restore, deleted
clans, container restart, log viewer).

## Discord bot

Configured **per clan from the Clans page** (token, then server, channel and
DM recipients picked by name) — not via environment variables. Clans sharing a
token share one gateway connection.

- **`/leaderboard [period]`** — `daily | weekly | monthly | all` (default
  weekly).
- **`/me [player] [period]`** — your own progress, answered privately.
- **`/status`** — scanner status and totals.

Commands are locked to the one configured channel. The bot also posts scan
reports, a **daily digest** after the first scan following the game-day reset,
and an optional **weekly digest** at the end of the clan's week. Each digest
can also be DM'd to up to 20 members as plain text ready to paste into in-game
chat. Leaderboard tables are sent as plain-message **code blocks**, not embeds,
because embeds are too narrow.

## Scoring & game day

- **Points are per clan.** Each clan has its own scoring table on the Chest
  Points board (edited by superadmins; a clan's values can be copied from
  another clan). A chest's value is looked up by `(source, chest name)` with
  precedence: exact override → source wildcard → built-in default, using the
  values in force on the day the chest was earned.
- **Triumphal chests** are worth a third of their package value each (values
  are global, superadmin-managed) and are kept out of the main leaderboard.
- **Game-day rollover** is a fixed UTC hour (**default 17:00 UTC**, not
  midnight; the game ignores daylight saving). Daily/weekly/monthly periods and
  the Discord digests all snap to this boundary so they match the game's day.
- **Weeks** follow each clan's week shape: Sunday to Sunday, or Tin Man to Tin
  Man.

## Development

```bash
npm install
npm run dev        # tsx watch on src/index.ts
npm run build      # tsc -> dist/  (commit dist/ before deploying)
npm start          # run compiled dist/index.js
npm run typecheck  # tsc --noEmit (app + tests) — what CI runs
npm run test:run   # vitest
```

CI ([ci.yml](.github/workflows/ci.yml)) runs the typecheck, the full test
suite, and a rebuild that must match the committed `dist/` on every push and
pull request.

- **Source:** `src/` (TypeScript). **Compiled output:** `dist/` (committed, run
  by Docker). **Frontend:** `src/web/public/` (vanilla HTML/CSS/JS, copied
  as-is). **Game protocol client:** `src/game-protocol/`.
- **Database:** single `better-sqlite3` file (`data/tb-chests.db`, WAL mode)
  holding chest, member, resource, game, ChestTracker, user, and clan data.
  Migrations run automatically on boot. Daily gzip backups land in
  `data/backups/`.

See [CLAUDE.md](CLAUDE.md) for build/deploy conventions and the reasoning
behind the parts that look odd, and [CONTRIBUTING.md](CONTRIBUTING.md) if you
plan to send a patch.

## Security

Please read [SECURITY.md](SECURITY.md) before exposing this to anything. Short
version: it holds a live game login and other people's data, it is built for a
trusted network rather than the open internet, and vulnerabilities should go to
a private advisory rather than a public issue.

## Licence

[MIT](LICENSE). Not affiliated with, endorsed by, or connected to Total Battle
or Scorewarrior; all game names and assets belong to their owners.
