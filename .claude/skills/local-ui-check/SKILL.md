---
name: local-ui-check
description: Run the TB Chest Counter dashboard locally against a sanitized copy of the newest prod backup, signed in as the superadmin, and screenshot pages per language and viewport (desktop 1440 / phone 390) with Playwright — plus an automated check for horizontal overflow, clipped and spilling text relative to English. Use when the user asks to run the app locally, take screenshots, or check that a UI change (new strings, translations, CSS, tables) doesn't break the layout.
---

# Local UI check

Real data, real pages, nothing leaves the machine. Built for the i18n rollout (Oct 2026); it's how the five-language layout pass was done.

**Ask before starting a server** unless the user asked for it in this task (standing rule: no local servers without asking). Everything runs from the **repo root**, in Git Bash.

## 1. Prepare and start

```bash
npm run build                                          # the server runs dist/
node .claude/skills/local-ui-check/prep.cjs            # newest backup in data/exports/dbbackup/, or pass a path
```

`prep.cjs` copies the backup (+ `-wal`/`-shm`) into the run dir — `%TEMP%\tb-local-ui` by default, `TB_UI_RUN` to override — deletes `ct_config` (the ChestTracker loop runs even in dashboard-only mode), blanks the clans' Discord tokens, adds a 30-day superadmin session, and prints the exact start command. Run that command with `run_in_background: true`:

```bash
APP_CONFIG_PATH=".../tb-local-ui/app.env" DB_PATH=".../tb-local-ui/run.db" WEB_PORT=3999 DISCORD_ENABLED=false node dist/index.js --dashboard-only
```

Ready when the log says `Web dashboard available at http://localhost:3999`. Dashboard-only = no browser, no scanner, no Discord bot. Migrations run on the **copy**. `prep.cjs` overwrites the copy, so stop the server before re-preparing.

## 2. Check

```bash
node .claude/skills/local-ui-check/layout-check.cjs                       # all pages × en,es,fr,ru,de × desk,phone
node .claude/skills/local-ui-check/layout-check.cjs en,de,ru users,members  # a subset
node .claude/skills/local-ui-check/snap.cjs users ru phone --el .audit-table
node .claude/skills/local-ui-check/snap.cjs dashboard de desk --click '#userMenuBtn'
node .claude/skills/local-ui-check/snap.cjs dashboard ru phone --click '#hamburgerBtn'
node .claude/skills/local-ui-check/snap.cjs login ru phone --signed-out
```

Page keys: `dashboard analytics leaderboard members member might events tools triumphal resources resadmin sessions external admin users clans system share login` (`member` and `share` come from the DB). Then **Read the PNGs** — the numbers find candidates, only the image tells you whether it's broken.

`layout-check` prints, per page/viewport/language: JS errors, a wrong `<html lang>`, horizontal page overflow, elements spilling past the viewport (sideways-scrolling strips excepted), text clipped in a box, text overflowing its own box, and text cut by a clipping parent — the last three only where English doesn't do the same. Shots and `results.json` go to `<run dir>/check/`; snaps to `<run dir>/snaps/`.

**The scanner chrome is faked.** Dashboard-only mode has no scanner, so its `/api/status` has no next scan, state `unknown` and a "calibrate" banner — and the sidebar's next-scan countdown, which prod shows on every page, never rendered. That's how the first translation pass shipped «Следующее сканирование через 1 ч 0…» cut off by the sidebar. Every context now answers `/api/status` like a running prod scanner (idle, next scan in ~1h 00m 59s, calibrated). Pass `realStatus: true` to `newContext` for the raw response.

Reading the results:
- **Intentional ellipsis is reported too**: compact-row sub-lines (`.mrow-sub`), clan-chip roles — judge from the shot.
- **Sort-header buttons** overflowing by a few px (`Gardisten`, `Могущество`) eat cell padding and look fine; anything visibly cut (the Ancient planner's narrow first column) gets a shorter translation.
- **Collapsed content** (closed `<details>`, a compact row's expand panel) is skipped by the check but opened by `snap.cjs` — snap it to see the expanded layout.
- **Locked column widths** (`table-layout: fixed` + colgroup) are a design rule: fix an overflowing translation by shortening it in `lib/i18n/<lang>.js` or by widening that column, not by unlocking the table.

## 3. Stop

Stop the background server task (TaskStop) and confirm `curl -s -o /dev/null -w "%{http_code}" http://localhost:3999/login` fails. The run dir is disposable.

## Gotchas (all hit once)

- **No Playwright browser bundle** on this machine — the scripts drive the system **Edge** (`channel: 'msedge'`). `TB_UI_BROWSER=chrome` or `bundled` to change.
- **Git Bash mangles arguments starting with `/`** (`/#users` → `C:/Program Files/Git/#users`). That's why the scripts take page *keys*, not URLs, and pick their own output paths.
- **The account's language beats localStorage** (`adoptAccountLanguage` reloads to it), so `newContext` PUTs `/api/auth/language` before each language — switching languages via localStorage alone reload-loops.
- The prod backups live in `data/exports/dbbackup/`; never use `data/tb-chests.db` and never write into `data/`.
