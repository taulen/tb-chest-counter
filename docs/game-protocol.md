# Game protocol (direct client)

Total Battle's web client talks to its servers over plain HTTPS with a binary
MessagePack format. We speak it directly — no browser — to read the clan
record (members + both gift tabs), player records, the Clan Capital ledger and
any player's city (research + hero talents). Code: [`src/game-protocol/`](../src/game-protocol/).

Status (Nov 17 2026): **this is the scan.** Each clan in a cycle (and each
manual scan) is `ScanLoop.runProtocolClanScan`:

1. [`game-protocol-phase.ts`](../src/scheduler/game-protocol-phase.ts) signs in,
   reads the clan record (members, gifts), player records and the ledger, syncs
   members, and returns its live session and data;
2. [`protocol-scan.ts`](../src/scheduler/protocol-scan.ts) records every gift —
   `count − rows already carrying its game_gift_id`, so re-runs never double —
   THEN claims them (15013): single Gifts-tab chests one request per chest
   TYPE (every gift of that type, like the game's own "Claim chests" — SIK's 49
   took ~15 s one by one), Triumphal chests and bundles one chest per request
   like the Open button; a refused batch is retried chest by chest; each
   request's (summed) rewards → `game_claims` with `batch_size` / `gift_ids` (v109),
   THEN imports the ledger;
3. the session is finalised like any scan (`finalizeScanSuccess`, Discord report).
4. then, on the same session, the slower collection (`collectCaptureExtras`:
   member cities, map tiles, raw archive) and chat. It used to run inside step
   1, so the daily city pass (~0.4 s a member) held the chests up: SIK's first
   captains scan read 99 cities for 42 s before opening 49 chests. The scanner
   stays busy until it is done, so deploys still wait.

A capture that cannot sign in creates no session row and records nothing.
The browser-driven OCR scanner this replaced (with its calibration wizard,
member-capture onboarding and OCR might / Clan Capital captures) was removed in
Nov 2026; the only browser left is the login bridge's.

Names: game names are exact, so no correction runs. Each resolves to the
spelling already stored for it when `normalizeGiftText`
([`gift-text.ts`](../src/game-protocol/gift-text.ts)) matches (the OCR era
stored "Lvl 25-29 Vault of the Ancients", the game says "Level 25–29 …"), then
the clan's chest/source merge rules apply as before, so point values keep keying
on the same names.

Ledger → `resource_transactions` ([`ledger-rows.ts`](../src/game-protocol/ledger-rows.ts)):
one row per entry (`game_entry_id` unique); kind 1 = clan payout (direction −1),
kinds 2/3/4/7 = donation (+1), kinds 5 and 8 (leader-side treasury entries:
only ever the clan leader, at the reset, never in the in-game history) are not
imported; item → resource type by name; Clan Speedups in
hours. Only entries on game days AFTER the clan's newest row from the retired
OCR capture are imported, so the switch-over day is never counted twice.
Deleting a ledger batch is recoverable: the next scan re-imports any entry the
game still lists (about two weeks), keyed on its entry id.

**Adding a resource type** the game introduces is two halves: a migration
seeding `resource_types` (name + slug — the ledger maps an item to its type by
name, and an unmapped item is left out with a log line). Its icon comes from
the game's own bundles, matched by name (game-art `resources` mapping) — no
image is ever added to the repo.

Before the switch, a parallel run compared every OCR scan with the game's gift
list (`game_scan_comparisons`, `[game-vs-ocr]` log lines): 100% matched, no
misreads, across all clans. The comparison code went with the OCR scanner; the
table keeps its rows.

Why the client copies the browser's sign-in exactly: CWB's website session
ended during development after a burst of direct logins, local browser windows
on copies of its session and new device identities. The client follows the
browser's full sequence (`/en/` → `GetGameStartData` → `bytokenoauth`) and
writes rotated cookies back ([`site-session.ts`](../src/game-protocol/site-session.ts));
on a throwaway account five such logins in a row, plus four replays of the old
flow, all left the session alive.

## Game art ([`src/game-art/`](../src/game-art/))

The game's own sprites, extracted on the server in plain Node — never stored in
the repo. `versions.totalbattle.com/config` → `unity_catalog_version.webgl` names
the asset catalogue at `assets-unity.totalbattle.dev/webgl/<hash>` (custom
binary: per bundle a name, group, content hash, bundle hash and the lower-cased
asset addresses inside). Only bundles holding images we use are downloaded
(heroes, troops/mercenaries, research/talent icons, chests, resources, clan,
events),
decoded (UnityFS + LZ4 → SerializedFile type trees → Texture2D RGBA32 / RGB24 /
RGB565 / DXT1 / DXT5, Sprites cut from their atlas — pixel-identical to UnityPy
on 2188 references) and written as PNG to `data/game-art/<catalog>/` with an
`index.json` (images + mappings). Runs at startup and daily; a new catalogue
re-downloads only changed bundles; current + previous version are kept.

Served public and path-versioned (`/game-art/<catalog>/<name>.png`, immutable)
per [cloudflare-caching.md](cloudflare-caching.md); `GET /api/game-art` gives the
names and mappings. Mappings: hero portrait by `game_players.hero_avatar` (= T13
row id), every Tools troop and citadel defender (`troops`: TROOPS + DEFENDERS of
`lib/citadel-sim.js`, by name + exact strength/health against T9 — all 162 match
since the one named from the wiki, "Many-Armed Giant", took the game's
"Many-Armed Guardian"), tech and talent icons from T21 f3, chests and resources by name,
captain portraits from T75, and the Ancient planner's pictures (`ancients`,
`EVENT_ART` in [selection.ts](../src/game-art/selection.ts)).

**Only the game's own art is shown** — no game, wiki or third-party picture is
committed (the troop webps and Ancient cut-outs were removed in Nov 2026). A
troop the art lacks shows a neutral tile with its initial (`troopIconHtml` in
`lib/game-art.js`); an Ancient picture the art lacks is left out.

**Spine stills** ([spine.ts](../src/game-art/spine.ts)): the Ancients artifacts
(Tome of Knowledge, Enchanted Figurine, Mysterious Clock) exist in the game only
as animated icons (`clandoom_icon_book_anim`, `clandoom_icons_statue_anim`,
`clandoom_icons_hourglass_anim`, linked from the `clandoom_artifacts` config).
Such a bundle holds one texture with every animation part packed in, plus a
TextAsset `<name>.atlas` (Spine 4 text atlas) naming each part's rectangle; the
picture is the region holding the whole object (`book`, `Layer 107`,
`hourglass`), cut out and un-premultiplied (`pma: true`). The Tin Man is the
plain `map_clan_doomsday_boss_scaled` (the event map's boss art).
`ART_SELECTION_VERSION` (store.ts) is bumped whenever the selection or the
mappings change, so an install re-extracts without waiting for a game patch.
`GAME_ART_DIR` / `GAME_STATIC_DIR` override the caches for local runs only.

## Chat (v104)

[`chat.ts`](../src/game-protocol/chat.ts) + [`chat-capture.ts`](../src/scheduler/chat-capture.ts):
the game's chat is Sendbird (app `1CA99C8C-…`). Message 414 (body `[[]]`) on
the game session returns a 40-hex chat token; a WebSocket to
`ws-<app>.sendbird.com` with subprotocol `{"token": "<hex>"}` (URL-encoded,
spaces as `+`) answers `LOGI{…key…}`; the REST API
(`api-<app>.sendbird.com/v3`, header `Session-Key`) lists the user's channels
(`/users/tb:<n>/my_group_channels`) and pages history
(`/group_channels/<url>/messages?message_ts=…&prev_limit|next_limit`). The chat
user is the website account (`tb:<n>`), so clans scanned through one website
account share private messages.

Kept: `clanGroup` (`triumph_clan_channel_<gameClanId>`, always included even if
unlisted) and `whisper` (1:1 private messages) — not realm or public channels.
Each scan refreshes the session key and syncs; a poller reads new messages every
minute on the cached key (no game or website traffic). The first sync of a
channel backfills (history reaches months back: a realm channel returned 600
messages from three months). Tables `chat_channels` / `chat_messages`.

## Members and collection (v103)

Each capture also, every cycle:

- **syncs members** ([`member-sync.ts`](../src/game-protocol/member-sync.ts)):
  `members.game_player_id` links a member to the game's permanent player id.
  First link: exact name (after the clan's player merge rules), else a fuzzy
  name whose last might is within ±15 %, else a new member under the exact game
  name. Linked members take the game's spelling (old name kept as an alias,
  `rename_member` audited with `source: 'game'`), get `clan_role`, are marked
  seen and get the day's might + hero-level snapshot. With a roster of ≥ 5,
  every ACTIVE member the roster does not account for is removed (soft delete,
  `member.left_clan` audited with `linked: true|false`): players who left,
  and unlinked rows from the OCR era/old spellings.
  `[Unknown]` is exempt. Gift senders and ledger players outside the roster are
  credited through `makeMemberResolver`, which never reactivates anyone.
  An alt that a merge rule folds into a member another player owns is only
  marked seen there — never linked, renamed or snapshotted from the alt.
- **reads map objects** on the tiles around members' cities (3×3 tiles each,
  capped at 60) and keeps vaults plus member-owned objects (`game_map_objects`).

Once per game day: every member's city (601: research + talents into
`game_player_techs`, with `game_player_tech_history` rows only on change;
captains into `game_player_captains` (v108); buildings + hero into
`game_city_snapshots`; ≤ 120 cities a cycle), and a gzipped raw copy of the
clan record and each clan-owned object (record f5, Clan Capital) in
`game_raw_snapshots` — kept raw so fields we have not mapped yet still have
history. Each city reply is archived raw too (kind `city`, one per player per
game day, the day's latest read; ~5 KB gzipped; kept 60 game days): captains
sat in field 9 all along, and without the raw reply every city had to be read
again to get them. Each part is isolated: one failing costs nothing else.

### Captains (city field 9)

Field 9 of every 601 city reply — **any player's**, not only the signed-in
account's — lists the captains the player owns. Per entry:

| Index | Holds |
|---|---|
| 0 | captain id (T75); id 1 is the hero (no T75 row), skipped |
| 1 | active line-up slot, 1–3 (0 = not in it) |
| 3 | `[cityId]` |
| 9 | experience |
| 10 | **level** (what the Captains screen shows) |
| 12 | equipment `[captainId, slotId, itemUid, 100]` — item instances, not types |
| 14 | skills |
| 18 | **star level** |

Calibrated against the game's Captains screen (Nov 2026): Cleopatra 278 ★5,
Aydae 235, Leonidas 234 ★2, Dustan 151 ★6, Artemisia 136 ★1; Carter, Helen and
Farhad in slots 1/2/3. `game_player_captains` holds the current level, stars,
XP and slot; `game_player_captain_history` a row when a captain is new or its
level or stars move (XP alone moves every battle and is not history). Members
with no captains stored are read on the next scan whatever the day.

Field 30 is NOT captains: it is the signed-in account's own **army** —
`[unitId, count, 0]` per troop type, T9 ids that merely overlap T75 (v106
stored it as captains; v107 cleared it).

Not read yet: the Stats screen's Leadership / Authority / Dominance / Might and
"Features" block (probably built from the skills), and equipment / artifact
bonuses (the city data only carries item instance ids).

v103 also adds the columns the protocol scan will use: `chest_records` /
`triumphal_chest_records.game_gift_id`, `resource_transactions.game_entry_id`
(unique) and `game_claims`.

## Session check

[`session-check.ts`](../src/scheduler/session-check.ts) GETs `/en/` with each
active clan's stored cookies every 30 minutes (and the capture does the same
before each scan). It presents no token, so it is safe to run often. A logged-in
page clears "Needs re-authentication"; the site's own logged-out page sets it,
through [`session-health.ts`](../src/scheduler/session-health.ts) — the same
path the scan's game capture uses (System warning keyed for auto-resolve, one
Discord ping per streak). Anything ambiguous (HTTP error, maintenance page)
changes nothing. Before this, "Authenticated" only meant "a session file
exists", so a dead login looked fine for as long as scans were paused.

## Rules that bite

- **Never present an old website token.** The site rotates its JWT on every
  `GetGameStartData`; sending a superseded one gets `Invalid token` **and ends
  that account's website session** (the stored session cookie stops working, so
  the scanner needs re-authentication). The client therefore always takes a
  fresh token from `GET /en/` and never stores one. This happened once to SK7
  during development (Nov 17 2026).
- **A direct login takes over the account's game session** — including one an
  admin has open in the login bridge, which is why the scan loop pauses while
  the bridge is open. Never run the client while someone is driving the same
  account through the bridge.
- **The game server gets no cookies.** Its only auth is the session id from
  the login reply. The website cookies are only for steps 1–2 below.
- Only our own clan's record carries members and gifts; records of other clans
  (fetched when browsing rankings) come with empty lists.

## Login chain

1. `GET https://totalbattle.com/en/` with the clan's stored cookies
   (`data/clans/<id>/storage-state.json`). The reply sets a fresh
   `__Host-user_auth_token` (JWT), and the page embeds the game account id
   (`"suid":"tb:…"`) and a `realm_id → logic_url` map of game servers. A
   logged-out page (no suid) means the clan needs re-authentication.
2. `POST /restapi/totalbattle/web/` JSON-RPC `GetGameStartData(suid, token,
   human_data)` → `sig`, `realmID`, `stringGuid` (player id), `accountId`,
   `human_data` (server echo: ip, country, language, email), `new_token`.
3. `POST <logic_url>` message **203**, seq 1, zero session id, body
   `[[suid], [""], sig, loginHumanArray, "", 0, 0, deviceId, 0, 1, "{}",
   [accountId, createdAt], deviceInfo, ["webgl", clientVersion]]`. The human
   array is the client's fixed field order (12 fields, two blanks, the rest) —
   see `loginHumanArray`. Reply `body[0]`: `[2]` session id (12-byte bin),
   `[0][0]` player id, `[6][2]` `[nickname, [clanId], …]`, `[6][1][3]` realm.
4. Every further message: head `[type, ++seq, [[playerId], sessionId], ""]` +
   body. No trailer needed.

The device identity (`deviceId`, fingerprint) is generated once per clan and
kept in `data/clans/<id>/game-device.json`. The WebGL client version isn't in
any text endpoint; it's `DEFAULT_CLIENT_VERSION` (override:
`GAME_CLIENT_VERSION`). A login with no session in the reply after a game
update is the cue to refresh it.

## Wire format

Frame: `u32le len` (whole frame) · `u32le replyLen` (header + message) ·
message · trailer. Message = MessagePack **with little-endian multi-byte
numbers and lengths**: a head `[type, seq, …]` then body values. Type 2 is a
batch of nested frames. Reply trailers are pushed events (`u32le len` incl.
itself, `[objectId, evType, ts, code]`, body); request trailers are event acks
`[[streamId, lastCount], …]` (not a checksum). The encoder writes the smallest
form for each value — 181 captured requests re-encode byte-identical.

## Messages

| Type | Ask (body) | Reply |
|---|---|---|
| 15000 | `[[[[clanId], 2147483647]]]` | clan record: `[0]` clan id, `[1]` tag/name/description, `[2]` members `[[id], role, joinedAt]`, `[3]` ~860 `[[id], ts, 0]` (departures), `[13]` gifts `[giftId, [senderId], giftType, expiresAt, count, tab]` |
| 402 | `[[[id], [id], …]]` | player records: `[1]` suid, `[2]` name, `[4]` hero avatar (T13), `[7]` hero level, `[8]` city level, `[9]` VIP, `[10]` might, `[11]` clan id, `[13]` clan tag, `[15]` `[realm,x,y]`, `[16]` city id, `[22]` `[1]` = Gold Pass |
| 15031 | `[[[clanId], 0]]` | ledger `[entryId, [playerId], kind, resource, ts, [{res: amount}]]`, ~14 days (second value is not a filter) |
| 601 | `[[[[[cityId], 0, 2147483647]]]]` | city details: `[1][0]` owner, `[9]` captains (see above), `[12]` buildings, `[17]` `{techId: [techId, level]}` research and hero talents, `[26]` hero, `[30]` own army |
| 312 | `[[[tileIds], [versions], [], []]]` | map objects per 20×20 tile; `tile = floor(y/20)*50 + floor(x/20)` |

Gifts: lifetime 20 h (arrival = expiry − 72000 s). `tab` 1 = Gifts, 2 =
Triumphal; `count` is chests in the entry (Bank bundles 3 or 30). Gift ids are
sequential per clan, so gaps are losses. Ledger kinds seen: 4 donation (res 20
Scientific Tractates, 31 Dragon Coins, 21–23 Boards/Cement/Steel, 74284 Magic
Seeds), 7 Forest Essence (74285), 3 basic resources (2–6), 2 speed-up with item
counts (2050 1h, 2051 3h, 2052 8h, 2053 15h, 2054 24h, 2055 72h).

## Names (static data)

[`static-data.ts`](../src/game-protocol/static-data.ts) builds `names.json` per
game version under `data/game-static/<version>/` from the game's public CDN:
`versions.totalbattle.com/config/?branch=current&simple=true` →
`client_static_version.production` (strings, vectors, no_duplicates) and
`client_translations_catalog_version` → `csv_en_US` zip. Table cells reference
the string pool by index; localised text is a **vector** of string refs, and
templated text is `[template, placeholder, value, …]` ("Level %value% Crypt").
Each table has its own id space:

| Table | Holds | Name |
|---|---|---|
| 7 | map objects | f3 vector |
| 8 | gift types | f3 chest name, f14 source template |
| 13 | hero avatars | f1 name, f3 icon |
| 21 | techs (research ~1000–1840, talents 25xxx/29xxx) | f1 name, f5 levels |
| 75 | captains | `battler_unit.name.<key>` from f7's `animationLinkage` (`battler_<key>_unit`), else the f5 vector |

Captains (T75): f1 kind, f2 rarity (1 rare, 2 epic, 3 legendary, 4 mythic;
labels `client.captain.info.<rarity>_captain`), f7 JSON config (`smallIcon`
portrait, `unitAltarArt` full art), f10 per-level stats (500 levels), f12 star
levels `{star: [star, cond, cost, …, [7] props JSON, [8] …]}` — the props are the
Stats screen's "Star level N" lines (`{"props":[{"propText": key, "propValue":
"+50,0%"}]}`). f5 is wrong for some rows: id 28 is Helen (her sprites and
battler) but its f5 vector says "Hercules", so the battler name wins. Their
es/fr/ru/de names and bonus texts come from the game's own CSVs (tGame).

`names.json` carries a `format` (NAMES_FORMAT); a cached file with an older
one is rebuilt once.

A rebuild downloads ~67 MB and decodes only the tables it needs (the rest are
skipped unbuilt), about 7 s.

The game's source text differs from what the OCR era stored in places ("Level
25–29 Vault of the Ancients" vs our "Lvl 25-29 …"); the protocol scan maps each
game name onto the stored spelling (`normalizeGiftText`) so history stays
continuous.
