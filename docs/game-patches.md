# Game patches

The game publishes a patch whenever its versions config changes
(`versions.totalbattle.com/config?branch=current&simple=true`). Four parts of
the app rebuild from the game's own files on a patch; a scan itself does not
depend on them, but the site does.

| Reader | What it reads | Key in the versions config | Code |
|---|---|---|---|
| Game names and texts | static data (~67 MB) + translation CSVs | `client_static_version.production`, `client_translations_catalog_version` | `game-protocol/static-data.ts` `loadGameNames` |
| Research trees | the same static data + ~25 layout bundles via the asset catalogue | + `unity_catalog_version.webgl` | `game-protocol/tech-trees.ts` `loadTechTrees` |
| Game art | the asset catalogue + ~5,200 bundles; unit frames from the client build | `unity_catalog_version.webgl`, `webgl_client_version.default` | `game-art/store.ts` `ensureGameArt` |
| Client version | PlayerSettings.bundleVersion in the client build's data file | `webgl_client_version.default` | `game-patch/client-version.ts` |

New content (a new chest, research, icon, translation) needs nothing from us:
the readers pick it up. What needs a fix is a change in the **shape** of a file,
or a guess of ours about it turning out wrong. Nov 25 2026: the catalogue's
bytes 4–7, read as a fixed header, were really the bundle count; the patch added
bundles, every catalogue became "not a catalogue", and the Research tab went
blank on every clan. Nothing said so until someone looked at the tab.

## What happens on a patch

1. **The watcher** (`game-patch/watch.ts`, started at boot) reads the versions
   config every 10 min (~16 KB). When a part changed, it runs all four readers
   at once instead of each waiting for its own trigger (a scan, a page load,
   the daily art run).
2. **Each reader reports** to `game-patch/status.ts` (`data/game-patch.json`):
   read, or failed and with what error.
3. **A failure keeps the previous patch's data in use.** Names and trees serve
   the newest copy on disk; art keeps the served version; the login keeps the
   client version it had. Nothing goes blank unless there was never a copy.
4. **A failure alerts once** per reader and game version: an alerting warning
   (System dot) keyed `game-patch:<reader>`, resolved by the reader's next
   success. A failing reader is retried every 30 min — never per page load or
   scan, since names and trees are ~67 MB each.
5. **System → Game Patch** shows every reader: read / previous patch / not
   available, since when, the error, and the client version the login sends.
   **Check now** runs every reader with the retry waits lifted.

## How we hear about it

- **The hourly canary** (`.github/workflows/game-patch.yml`) runs
  `scripts/game-patch-check.mjs` on GitHub's runners — this repo's code against
  the live game, independent of prod — once per patch (a patch that reads is
  remembered in the Actions cache). When something can't be read it opens a
  `game-patch` issue with the report and fails that run: both notify the repo
  owner. Hourly retries of the same patch stay green (no repeat emails); the
  first run that reads closes the issue. It also checks what prod only warns
  about: every art bundle, the unit frames from the client build, all four
  text languages, no empty tree.
- **The System dot** on prod, from step 4 above.

## Fixing one

1. `gh issue list --label game-patch` (or System → Game Patch) says which
   reader and the error.
2. Reproduce: `npm run build && node scripts/game-patch-check.mjs --work <scratch dir>`.
   It reads the live patch into the scratch dir only (never `data/`), the same
   report as the issue.
3. A format error: fetch the failing file and the previous patch's and compare
   bytes. The previous hashes are in prod's `data/game-patch.json` (`served`),
   `data/game-art/state.json` (`previous`), or the last good canary run; the CDN
   keeps old versions. URLs: `catalog.ts` and `webgl-client.ts` headers,
   `static-data.ts` for the static files. Nov 2026's case took one `xxd` of
   each catalogue: `30 38 00 00` → `bb 38 00 00` was 14384 → 14523, the entry
   count.
4. Fix the parser, pin it with a test on made-up bytes (the repo is public —
   never commit game bytes), `npm run build`, push, deploy
   (`scripts/deploy-when-idle.mjs`). Prod's reader clears its warning on its
   next retry, or at once with System → Game Patch → Check now; the canary
   closes the issue within the hour.

## The client version the login sends

The scan's game login sends `["webgl", clientVersion]` (message 203). It used
to be a constant set by hand, "refreshed when a login fails after an update".
Now it is the live build's own Application.version: the art run reads it from
the client data file it downloads anyway, else the watcher downloads that file
once per client build (~43 MB). Order: `GAME_CLIENT_VERSION` (docker-compose;
empty = follow the game) > the build's, once read and not older than the
fallback > `FALLBACK_CLIENT_VERSION`. A login that gets no session says which
version it sent.

PlayerSettings has no type tree in a player build and its offsets move with
the engine, so the version is found as the one length-prefixed string shaped
`N.N.N` in the object; none or two different ones fail loudly.

## What's new (Tools → What's new, every member)

Every patch is also **compared with the one before**, and what it added is a
page: `#tools/whats-new`, a slim note on Home (for a week; until followed, put away with ✕
or What's new is visited — per browser, back with the next patch; an account made
after the patch sees it only while the patch is ≤3 days old), and a link from
System → Game Patch. A patch ships content long before it goes live (art first,
then data, then texts), so this is where a coming feature shows first: the
Nov 25 2026 patch carried the Clan Duel and Army boost trees, the Ascendant
Arena, Warlords' Brawl, a reworked Temple, four captains revealed from
placeholders and King Arthur / Shaka Zulu as art only.

Built by `game-patch/notes.ts` after the readers on every watcher pass (cheap
when nothing moved), so the first run on a volume notes the newest patch
against the one before it on disk. Four parts, all diffs of the game's own files
(`game-patch/notes-diff.ts`, pure):

| Part | From | Shows |
|---|---|---|
| Sections | `names.json` and the art slice `static-<key>.json`, every key | added, **revealed** (a placeholder given its name: blank, a text key, or a name the game stamped on several ids — "Artemisia" ×5), renamed, changed (values compared as numbers: "+30%" = "+30,0%"), removed |
| Research trees | `tech-trees.json` | a new tree drawn as the game draws it (`treeHtml` preview), a grown one with its new nodes marked, and research the layout doesn't place yet (`unplaced`) |
| Texts | both translation catalogues from the CDN, English whole + de/es/fr/ru for what changed | grouped by feature (`textGroupKey`), titled by the feature's own window; new help windows as **guides** |
| Art | both catalogues' `catalog-names.txt` | a gallery of new pictures no entry shows, grouped by stem; each named by the art slice (`artNamesByStem`) and the texts that hold every part of its stem (`artTextKeys`) |

**Adding a kind of data needs nothing**: a key the registry doesn't know is
diffed and listed anyway (`genericSection`, rows). To make it read better, add
an entry to `SECTION_DEFS` in [notes-sections.ts](../src/game-patch/notes-sections.ts)
(name, sub line, pictures, drill-down detail, which values count as a change)
and to `SECTION_VIEWS` in [pages/whats-new.js](../src/web/public/pages/whats-new.js)
(label, layout: portraits / tiles / rows, the drill-down's facts).

The art selection's `patch` catch-all (selection 13) extracts what a catalogue
added since the previous one (≤ 1024 px, ≤ 400 a patch, no animations), so the
gallery has pictures beyond the icon catch-all's.

Kept: `data/game-patch-notes/index.json` (last noted versions + a summary per
patch) and `<id>.json` per patch, the newest 60. Pictures resolve against the
current art at request time; a patch whose art is gone shows names. A renamed
chest the site stores under its old name is an alerting warning (fold it with a
migration, [chest-identity.md](chest-identity.md)).

## Files

- `data/game-patch.json`: the watcher's fingerprint and every reader's status.
- `data/game-patch-notes/`: What's new, one file per patch.
- `data/game-art/client-version.json`: the client build hash and its version.
- `data/game-static/<key>/names.json`, `tech-trees.json`: per static version.
- `data/game-art/<catalogue>/`: per art version (current + previous kept).
