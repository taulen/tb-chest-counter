# Game protocol (direct client)

Total Battle's web client talks to its servers over plain HTTPS with a binary
MessagePack format. We speak it directly — no browser — to read the clan
record (members + both gift tabs), player records, the Clan Capital ledger and
any player's city (research + hero talents). Code: [`src/game-protocol/`](../src/game-protocol/).

Status (Nov 17 2026): **this is the scan.** Each clan in a cycle (and each
manual scan) is `ScanLoop.runProtocolClanScan` — clans on different accounts at
the same time (see [Scan lanes](#scan-lanes)):

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
(heroes, portrait frames, city looks, troops/mercenaries, research/talent
icons, chests, resources, clan, events, status icons),
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
`EVENT_ART` in [selection.ts](../src/game-art/selection.ts)). From the
customizations table T52 (f1 kind, f2 name, f4 visual JSON): portrait frames
(`avatarFrames`, kind 1, by `game_players.avatar_frame` = 402 field 6; the
`visual` sprite; 1 = "Standard", the default) and city looks (`cityLooks`,
kind 2, by `city_appearance` = 402 field 5; an icon per city level step, 9 =
"Player's City"). `status` names the small city-state pictures by key
(`STATUS_ART`): shield = the Shield of Peace item icon
(`booster_piece_shield_orange_72`), burning = `fire_in_the_fort_72`, wallsDown =
`destroyed_fortress_icon`, flame = `spells_magic_fire_22` (legible at 16 px),
city = `player_city_lv1_icon`, goldIngots = `gold_bar_72` (T8 item 16).
`player_feiry_city_*` is the "Fiery" city look, not a city on fire.

**The client's own UI art** ([webgl-client.ts](../src/game-art/webgl-client.ts),
category `ui`): frames, coloured backs and badges are not in the catalogue.
They are in the WebGL client build's Resources — `versions…config` →
`webgl_client_version.default` → `assets-webgl-client.totalbattle.dev/<build>/Build/Triumph.data`
(~43 MB brotli, ~69 MB raw; a `UnityWebData1.0` container whose
`data.unity3d` UnityFS bundle holds `resources.assets`). That file has **no
type trees**, so Texture2D is read with Unity's fixed 2020.2–2022.1 field
layout and accepted only when the read ends exactly at the object's size (a
newer engine fails loudly, never guesses). One download per client build;
reused across catalogue versions while the build is unchanged, and when it
cannot be read the previous version's frames are kept (or icons stay
unframed). The prefabs were read the same way (GameObject / RectTransform /
Image sprite references), which is where the geometry below comes from:

- **Unit icons** (`UnitIconView`, [unit-frames.ts](../src/game-art/unit-frames.ts)):
  72×72 box; back `back_icon_units_72x72_<colour>`; the portrait; frame
  `frame_icon_units_94x92_<colour>` (94×92, 2 px low); tier badge
  `icons_tir_<roman>_1` (33×33, top-left at −12/−10). The colour is the unit's
  **tier** (T9 f2: Archer I = 1 … Corax II = 9, Dwarf = 0) on the game's tier
  ladder — 0 grey, I white, II green, III blue, IV violet, V orange, VI red,
  VII gold, VIII–X whiteII/greenII/blueII (the same colours as its per-tier
  `drapery_tir_*`). The client picks the sprites in code; the ladder is how its
  art is named and coloured. VIII–X have no numbered badge: the plain disc of
  their colour family (`icons_tir_I/II/III_3`) with the numeral written over it.
  Mappings `troopTiers` (troop → tier, on the same rows as its icon) and
  `unitFrames` (tier → back/frame/badge/numeral).
- **Player portraits** (`UserIconView`): the 72-pixel portrait with the frame
  sprite stretched to 98×95 and centred 4 px low (`backForFrame` is opaque and
  belongs to frame previews, not drawn), and the **hero level** on a
  `LevelView` plate — 29×35, top-left 53 px into and 8 px above the portrait,
  the number centred. The view picks among `icons_tir_1` / `icons_tir_shield_1…6`
  in code; we use the sprite the prefab is saved with, `icons_tir_shield_4`
  (`heroLevelBadge`).
captain portraits from T75, artifact icons from T110's config (`artifacts`),
equipment icons from T11 f2 (`equipment`) and gem / enchantment icons from T8
(`inserts`), and the Ancient planner's pictures (`ancients`,
`EVENT_ART` in [selection.ts](../src/game-art/selection.ts)).

**Only the game's own art is shown** — no game, wiki or third-party picture is
committed (the troop webps and Ancient cut-outs were removed in Nov 2026). A
troop the art lacks shows a neutral tile with its initial (`troopIconHtml` in
`lib/game-art.js`); without its frame art, the plain icon; an Ancient picture
the art lacks is left out. A portrait without a frame image is the plain round
one (`heroAvatarHtml` in `lib/game-facts.js`).

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

**Retention (v113).** The service only serves recent history, so the stored
copy is the record:

- Messages are **permanent**: inserted the first time any read returns them,
  never deleted or blanked by a later read (the only delete is deleting the
  clan). A re-read of a known id replaces the text only when it really changed
  (an edit; the old text is kept in `previous_message`).
- Reads include the boundary millisecond both ways (`include=true`) and
  de-duplicate by id, so a message sharing a millisecond with the newest or
  oldest stored one is never skipped.
- The first read takes up to 20,000 clan-chat messages back from now; every
  later sync reads another 1,000 older (`readMessagesBefore`) until the
  service returns less than a page, then `chat_channels.history_complete` = 1
  and the channel is never asked for older history again. As of 2026-11-17
  the stored clan chat reached back to 2026-10-02 (clan 2, 20,052 lines),
  2026-10-21 (clan 3, 20,025) and 2026-11-11 (clan 5, 9,935) — the first two
  stopped at the 20,000 first-read cap, which this backfill now continues.
- `translations`: every message seen carries `{}` — the game's translate
  button calls its own endpoint and stores nothing. A filled map would be kept
  (`translations`, JSON) and shown in the viewer's language; we never call a
  translation service ourselves.

**Content.** Structured lines arrive as a placeholder in the text (`/%0%/`)
plus `data` = `{"subs": {"/%0%/": {…, "v": 1}}}` ([chat-text.ts](../src/game-protocol/chat-text.ts)):
`coord` (a shared location: `entryType` user / poi / tile / clan / landmark,
`x`, `y`, `realmId`, `staticId` = T7 map object, `name`), `raid` (`created`,
`targetStaticId`, `name` = who), `clan` (join / leave / kicked with `kicker` /
archived), `journal` (attack / crypt / scout / clan_announcement / pvpladder —
a shared report, `name` = its subject), `spawn_sabotage_spawn_to_enemy`
(`spawnerName`, `staticAtomId`, `targetClanName`, `atomCoord`), `clan_spawn`.
`custom_type` `service` = the game's own posts (raids, joins…). The sender's
`sender_info` (`realm,playerHex,clanHex,0,rank,tag`) gives the player id
(`sender_player_id`) and the clan rank when the message was sent.

**Search.** `search_text` = the text with each placeholder replaced by its names
and coordinates; `chat_messages_fts` (FTS5, external content on
`chat_messages.id`, unicode61 without diacritics, kept by triggers) indexes it
with `sender_name`. `GET /api/chat/clan` (any member of the active clan) serves
only the clan's own `clanGroup` channel — newest first, `before`/`after`
cursors `<ms>:<messageId>`, `q` (every word as a prefix), `sender`, `from`/`to`;
a search's first page also carries `matches` = how many messages match in the
WHOLE stored history and the oldest one's time —, `GET /api/chat/clan/context`
the conversation at a message (`around=<ms>:<id>`, a search hit) or a time
(`at=<ms>`, the first message at or after it: a date jump), 50 messages either
side, unfiltered, oldest first, with `focus`; and `GET /api/chat/clan/senders`
the writers. Private (whisper) channels are never reachable through any of
them. The page never loads the whole history: every request is one bounded
page, and at most 2,000 messages stay loaded (the far end is dropped and loads
again when scrolled to); the live poll runs only while the conversation shows
its newest end.

## Members and collection (v103)

Each capture also, every cycle:

- **syncs members** ([`member-sync.ts`](../src/game-protocol/member-sync.ts)):
  `members.game_player_id` links a member to the game's permanent player id.
  First link: exact name (after the clan's player merge rules), else a fuzzy
  name whose last might is within ±15 %, else a new member under the exact game
  name. Linked members take the game's spelling (old name kept as an alias,
  `rename_member` audited with `source: 'game'`) — unless an admin chose the
  name: a player merge rule naming the game name wins (its target is shown —
  Cyrillic game names merged into readable ones stay readable), then a name
  set by a manual rename; the game's spelling is always kept as an alias
  (Nov 17 2026, after the sync renamed six merged members back). The Admin
  review queue's "Likely Renames" (a might/level guesser, v92) was retired in
  Nov 2026 (v120 drops its table): the game reports renames through the player id. They get `clan_role`, are marked
  seen and get the day's might + hero-level snapshot. With a roster of ≥ 5,
  every ACTIVE member the roster does not account for is removed (soft delete,
  `member.left_clan` audited with `linked: true|false`): players who left,
  and unlinked rows from the OCR era/old spellings.
  `[Unknown]` is exempt. Gift senders and ledger players outside the roster are
  credited through `makeMemberResolver`, which never reactivates anyone.
  An alt that a merge rule folds into a member another player owns is only
  marked seen there — never linked, renamed or snapshotted from the alt.
- **reads map tiles** around members' cities (every member's own tile first,
  then 3×3 around, capped at 60) and keeps vaults plus member-owned objects
  (`game_map_objects`). Each tile's `[4]` lists its **cities** (43-field
  records: `[0]` city id, `[2]` owner, `[3]` 2, `[4]` clan, `[13]` level,
  `[17]` `[realm,x,y]`, **`[25]` 1 = burning (walls down)**, **`[39]` true =
  shield**), confirmed by the user against the map (Nov 2026). Members' state
  goes to `game_players.shielded/burning/map_seen_at` with a
  `game_city_status_history` row whenever it flips (v112); the profile, the
  public card and the Members list show it.

Once per game day: every member's city (601: research + talents into
`game_player_techs`, with `game_player_tech_history` rows only on change;
captains into `game_player_captains` (v108); buildings + hero into
`game_city_snapshots`; ≤ 120 cities a cycle, **20 per 601 request** — the game
client itself asks for a clan's 19 objects in one — split back into
single-city bodies by `splitCityReply`; a failed batch falls back to one
request per city), and a gzipped raw copy of the
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

### Captain equipment (city fields 9 + 10)

A captain entry's `[12]` is its six equipment positions,
`[captainId, slotId, itemUid, 100]` (positions 0–2 are usually empty, 3–5
hold the worn gear; slot ids are per captain, 129–134 for Carter). The uid is
an item instance in **field 10**, the player's item list (hero and captains,
~20–110 per player):

| Index | Holds |
|---|---|
| 0 | instance uid (64-bit; past 2^53 the codec hands it over as `"…n"`) |
| 1 | item type — a **T11** row, which already includes the quality grade |
| 2 | `[cityId]` |
| 3, 4, 5, 6 | 1000, a ∈ {0,1,3,6,10}, b mostly 0–40, c 0–31 — not decoded, stored raw |
| 7 | enchantment set into it (T8 item, f1 9), 0 = none |
| 8 | gems set into it (T8 items, f1 8) |
| 9 | the preset (captain entry `[14]` `[presetId, captainId, [six uids]]`) it sits in, 0 = inventory |

`game_player_captain_equipment` keeps what each captain wears per position;
`game_player_equipment_history` a row when a position gets a different item
(by uid), a different enchantment or gems, or is emptied (`item_type` 0).
Checked on the signed-in account's own city (Carter: Cursed Claw Coat, Godlike,
Pioneer Enchantment + Amber) and archived member cities (Nov 2026).

### Artifacts (city field 14)

**Field 14** is every effect active in the city, `[effectId, sourceBits,
count]` (~600 for a developed city): research, buildings, shop offers (sources
2048/4096 are T19 offers) — and the artifacts the **three line-up captains**
wear. Each such artifact adds one level effect (source 16384), one star-level
effect (8192) and its rolled random bonuses (1; count 2 = the same roll twice).
Every one of those effect ids belongs to exactly one artifact type in the
static tables (T111/T112/T113 below), so the effects say which artifact, at
what level and star level, with which rolls
([artifacts.ts](../src/game-protocol/artifacts.ts)). Artifacts on benched
captains are not in the city data at all: `game_player_artifacts.in_lineup`
marks one that dropped out instead of deleting it; history
(`game_player_artifact_history`) gets a row when an artifact comes into the
line-up or its level, star level or rolls change, and — `in_lineup = 0`, v118 —
when it leaves it. Because only line-up captains' artifacts are visible, a
first sighting after a player's baseline is "Into the line-up", never "a new
artifact" (Princess of Chaos swapping captains moved Mythril Pickaxe and Ifrit
Belt out and Chronoglyph in). Checked against the game's artifact book
(Nov 2026): Torch of Olympus, Legendary, level 50/60 "Crypt exploration
efficiency 130%", star level 21 (four stars and a partial fifth) "136%",
random bonuses Epic Crypt +100%, Common / Rare / Epic +50%.

**Message 61000** (sent at login, body `[[]]`) lists the signed-in account's
own artifacts, worn or not: `[[{$pairs: [[type], [[type], [cityId],
[starLevel], [level, xp], [{slot: [bonusEffectId]}, null]]]…}, {$pairs:
[[type], [captainId, 1] | null]}]]`. It ignores any argument (a city or player
id still returns the caller's own), so it cannot read another player — field
14 is the way.

**Re-reading the archive.** Artifacts and equipment were in every archived
city reply before they were parsed. `game_parse_markers` remembers, per clan,
which version of each city parser has replayed the archive (`CITY_PARSERS` in
[game-protocol-phase.ts](../src/scheduler/game-protocol-phase.ts)); a parser
added or changed is replayed over every archived reply, oldest read first, on
the next scan — bump its version to re-run it.

**The hero's gear.** Field 9's entry id 1 is the hero (no T75 row); it wears
equipment like a captain, so its items are stored under captain id 1
(`HERO_ENTRY_ID`, [equipment.ts](../src/game-protocol/equipment.ts)). It was
left out until Nov 2026; the `heroEquipment` city parser re-reads the archive
once for the hero ONLY (`saveCaptainEquipment(…, onlyCaptains)`), so the
captains' equipment history already stored is untouched. The Captains tab puts
the hero first in the line-up row (portrait in the player's frame with the
level plate, level / XP from the city's hero record, its gear).

**Captain pictures** (user, Nov 2026: "very different from what I see
in-game"). T75's config names four: `smallIcon` (carter_icon, the 72 px head
shot), `battleIcon` (carter_battle_icon, a 148×184 bust card),
`unitAltarArt` (lvlup_carter, the level-up art) and `unitInfoSprite`
(battler_carter_battlerinfo — not an image: an `_artbundle` JSON recipe
`{backName, frontName: "battler_carter", frontScale, …}` whose front PNG is
not an addressable asset). The captain screen's full-body picture is
`<smallIcon base>_scaled` (carter_scaled, 289×411: Carter with the torch, the
lasso and the potion satchel — the still of `carter_artbundle`'s front
"carter" over `heroes_back_abstract`). Nothing in the static data names it; the
client derives it, and `<icon minus _icon>_scaled` exists for 81 of 90 T75
rows (the older Beowulf / Skadi / Heimdall / Artemisia / Attila rows have only
the head shot and, some, the level-up art). Mapping `captainArt` = `_scaled`,
else the level-up art; the dialog and hover card show it.

**Captain tiles** are drawn like the game's line-up (unit-frames.ts
`captainTileArt`): the unit icon's back and frame in the RARITY colour
(1 rare → blue, 2 epic → violet, 3 legendary → gold, 4 mythic → red; the same
`back_icon_units_72x72_*` / `frame_icon_units_94x92_*` client sprites), the
head shot between them, the level on `icons_tir_shield_2` at the top-right and
`icons_star_up` per star along the bottom.

**XP to the next level is not shown:** the per-level XP thresholds were not
found. T75 f10's 500 per-level rows hold three growing values (Carter L200:
494,718 / 9,275,970 / 247,359 = half the first) — none sums or scales to the
stored XP (633,274,738,935 at level 200, "12,954,943,875 to the next level"
in the game); T73 (300 levels, 234,810,294,900 at 200) is another curve; no
static table holds a value between 600B and 700B outside map objects. XP is
shown compact (633.3B, locale-aware) with the full number on hover.

Not read yet: the Stats screen's Leadership / Authority / Dominance / Might and
"Features" block (probably built from the skills and T75 f11 star rows — not a
direct per-level value), and the instance fields a, b, c of an item.

### The clan itself (v111, My Clan page)

Every scan also reads the clan as the game's own clan window does — read-only
requests the client sends whenever that window opens — and stores it
([game-clan-repo.ts](../src/data/repositories/game-clan-repo.ts), `collectClan`
in [game-protocol-phase.ts](../src/scheduler/game-protocol-phase.ts)):

| Source | Field | Holds | Checked against |
|---|---|---|---|
| clan record (15000) | `[1][0]`, `[1][1]` | tag, name | Information tab |
| | `[1][6]` | the **Clan Capital**'s object id (also one of `[5]`) | object type 10001 in all three clans |
| | `[1][8]` | founded (unix s) | "Date founded 17 April 2026"; equals the capital's own creation time |
| | `[1][13]` | language (`en_US`) | |
| | `[2]` length / `[6]` | members / **member limit** | 69 / 100; limit = 60 + 10 per "Number of Clan members I–IV" the clan holds (SIN holds three → 90) |
| | `[7]` | clan **might** | Information tab 8,325,969,188 exactly; ≈ the members' might summed |
| | `[9]`, `[11]`, `[12]` | not decoded (`[9]`/`[11]` move by the minute; `[12]` `{[1018,1] → [n]}`) | stored raw |
| Clan Capital (601) | `[17]` | the clan's **research** `{techId: [techId, level]}` — trees 12 Clan territories (10000–10033), 13 Allies (10100–10163), 22 Fortifications (30–36, …) | CWB 96 techs, SIK 121, SIN 69 |
| | `[5]` | the **treasury** `{resourceId: [resourceId, amount]}` — ids name through the gift-type names (20 Scientific Tractates, 21–23 Boards/Steel/Cement, 24 Religious Tractates, 31 Dragon Coins, 9 Conquest points, 74284 Magic Seeds, clan fragments, tournament proofs) | |
| | `[1][13]` | `[realm, x, y]` — kingdom and coordinates | "K:260 X:801 Y:171" |
| 25 `[[[clanId]]]` | `{1, 3, 4, 5, 7, 9}` | key 1 might, key **7 wealth points** | "Clan wealth points"; 3/4/5/9 stored raw |
| 14003 `[[[capitalId]]]` | `[[[[key], value], …], …]` | key **30 help points** (Clan Capital → Border) | 5,576,273 on screen; others raw (37 moves with wealth) |
| 28001 `[[[clanId]]]` | `[[medalId, earnedAt], …]` | the (up to 4) medals the clan displays | Information tab |
| 23 `[[kind, 100, [], false]]` | `[[clanId, value], …]` | the kingdom's top 100 per ranking, NOT sorted — the rank is computed. Kinds (client config rating tabs, RATING_CLANS): **7 wealth**, **1 might**, **3 valor points gained**, **4 conquest points gained**, **5 crypt exploration**; 2 (gold bars) and 6 answer empty for clans | in-game Clan ranking; probed every kind from the throwaway account; kind 1 values = 15200's might |
| 15200 `[[[clanId], …]]` | `[[[clanId], logo, tag, name, type, 0, 0, memberLimit, members, language, might, 1], {[1018,1] → [n]}]` per clan | any clans' headline — the ranking lists' names and logos (100 clans a request) | |
| clan record `[1][2]` | logo code | background, frame and emblem ids, one byte each — see "Clan logo" below | CWB's axe emblem |

Tables: `game_clan_info` (current), `game_clan_stats` (a row per scan, with
`raw` for everything read but not decoded), `game_clan_techs` +
`game_clan_tech_history` (a history row only when a level moves; the first read
is the baseline, so it never shows as a level-up), `game_clan_treasury` (the
day's latest read per resource), `game_clan_medals`. A clan with no research
stored yet is first filled from its archived capital reply (`clan_object`),
dated to when that was read. Clan tree 17 (`clanTalentsTree17`, ids 7000/8000)
is not in the capital and is not shown.

Every scan stores the clan's rank and value in each ranking
(`game_clan_rankings`, a row per kind per scan, rank null outside the top 100)
and the latest list per kind with each clan's tag, name, logo and members
(`game_clan_ranking_lists`, v117) — the My Clan page's Rankings tab.

### Clan logo ([`clan-logo.ts`](../src/game-art/clan-logo.ts))

One number, the clan record's `[1][2]` (and 15200's `[1]` for any clan), one
byte per layer: `background << 16 | frame << 8 | emblem` — CWB 1118480 =
0x11_11_10 = background 17, frame 17, emblem 16 (the axe); SIK 660741 =
10/21/5; SIN 2168077 = 33/21/13. The client config `clan/logo` gives the
ranges (numBacks 49, numFrames 37, numElblems 37; the last seven of each are
NPC clans'). Every layer is a sprite of its own, small and `_lg` (87 px):
`clan_background_<b>` (the coloured field), `clan_mask_<f>` (the frame's
opening — only its alpha cuts the background), `clan_frame_<f>`,
`clan_emblem_<e>`. Composed bottom to top — background cut by the mask, frame,
emblem — all centred, by sharp on the server, cached per art version as
`<art>/<version>/clan-logos/<code>.png` and served public and immutable at
`/game-art/<version>/clan-logo/<code>.png`. No tint: the backgrounds carry
their colour.

Treasury and inventory rows show each item's own icon by item id (T8 f6
visual `icon`; `game-art/item-icons.ts`): every item icon is extracted
(category `items`), e.g. Clan Shield of Peace → `booster_piece_shield_blue_72`,
Proof of Victory in the Trials of Olympus tournament →
`icon_multistage_victory_points`, Proof of Glory in the Dark Omens tournament →
`icon_sabotage_victory_points`.

Clan medals are T62 in the static data: f1 icon (`achievement_<group>_<tier>`),
f4 unlock text, f5 name (shared by a medal's tiers: "Medal of Prosperity"), f6
tier 1 bronze … 4 platinum (labels `client_config.value.goblet_<tier>`).

v103 also adds the columns the protocol scan will use: `chest_records` /
`triumphal_chest_records.game_gift_id`, `resource_transactions.game_entry_id`
(unique) and `game_claims`.

## Request pacing

No rate limit has ever been seen. Gaps between requests vary
([`utils/request-gap.ts`](../src/utils/request-gap.ts)) instead of one fixed
tick, and are short: 25–75 ms between chest claims (a player clicking Open
manages under 100 ms), 30–90 ms between batched reads (cities, tiles, clan
objects). Reads are batched the way the client batches them: 100 players per
402, 20 cities per 601, 9 tiles per 312.

## Scan lanes

[`scan-lanes.ts`](../src/scheduler/scan-lanes.ts): a cycle scans clans on
**different Total Battle accounts at the same time** and clans on **one
account one after another**, in one lane — a game login takes over the
account's session, so two scans on one account at once would knock each other
out (SIK and SK7 share a website account). The account is the website user id
(`tb:<n>`, the `suid` on the site page) in `clan_scan_accounts` (v119),
learned by the 30-minute session check from the stored login (the same page it
already loads) and by every scan (`GameClient.suid` / `playerId`), and
forgotten when a new login is saved. A clan whose account is not known yet runs
**alone** — after every lane queued before it, before anything queued after it —
since it might share an account with any clan.

- A cycle queues each lane's clans in cycle order; lanes run side by side; it
  ends (and arms the next timer) when every lane is done.
- "Scan This Clan" queues on the clan's lane — straight away if the lane is
  free, right after the lane's current scan if not; a clan already scanning or
  queued is refused. "Scan All Clans" is refused while a cycle runs.
- Per-scan state (progress line, live chest count, start time) is per clan;
  `/api/status` lists every clan scanning (`activity.clans`) and the sidebar
  card shows them together ("CWB · SIK"). `scanner.busy` in `/api/health` holds
  while any lane has work queued or running, so
  [`deploy-when-idle.mjs`](../scripts/deploy-when-idle.mjs) still waits.
- The login bridge still pauses scanning globally.
- A shared rebuild (game names after a patch) runs once even when two lanes
  ask for it.
- `SCAN_PARALLEL=0` (docker-compose) puts every clan in one lane: the old
  serial scan.

## Session check

[`session-check.ts`](../src/scheduler/session-check.ts) GETs `/en/` with each
active clan's stored cookies every 30 minutes (and the capture does the same
before each scan). It presents no token, so it is safe to run often. A signed-in
page also names the account (`suid`), which keys the clan's scan lane. A logged-in
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
| 402 | `[[[id], [id], …]]` | player records: `[1]` suid, `[2]` name, `[4]` hero avatar (T13), `[5]` city look and `[6]` portrait frame (T52 customizations; v114), `[7]` hero level, `[8]` city level, `[9]` VIP, `[10]` might, `[11]` clan id, `[13]` clan tag, `[15]` `[realm,x,y]`, `[16]` city id, `[17]` Gold Ingots (public in the game; v110 keeps the current value on `game_players.gold_ingots` and the game day's latest in `game_player_daily` — they tick up every few minutes, so they are not part of `game_player_history`'s change check), `[22]` `[1]` = Gold Pass |
| 15031 | `[[[clanId], 0]]` | ledger `[entryId, [playerId], kind, resource, ts, [{res: amount}]]`, ~14 days (second value is not a filter) |
| 601 | `[[[[[cityId], 0, 2147483647], [[cityId2], 0, 2147483647], …]]]` (one or many) | city details (all records in `body[0][0]`): `[1][0]` owner, `[9]` captains (see above), `[12]` buildings, `[17]` `{techId: [techId, level]}` research and hero talents, `[26]` hero, `[30]` own army. `[5]` is the inventory `{itemId: [itemId, amount]}` (item 2 = Silver) — filled only in the signed-in account's own city; every other player's reply has it empty, so other players' resources are not readable |
| 312 | `[[[tileIds], [versions], [], []]]` | per 20×20 tile `[tileId, version, …, [4] cities, [5] objects]`; `tile = floor(y/20)*50 + floor(x/20)` |
| 25 | `[[[clanId]]]` | clan might (key 1) and wealth points (key 7) — see "The clan itself" |
| 14003 | `[[[capitalId]]]` | the Clan Capital's Border counters; key 30 = help points |
| 28001 | `[[[clanId]]]` | the clan's displayed medals `[[medalId, earnedAt], …]` |
| 23 | `[[kind, count, [], false]]` | the kingdom's clan ranking `[[clanId, value], …]`, unsorted; kind 7 = wealth |
| 601 | `[[[[[cityId], 0, 2147483647]]]]` | city details: `[1][0]` owner, `[9]` captains (see above), `[10]` item instances, `[12]` buildings, `[14]` active effects (artifacts), `[17]` `{techId: [techId, level]}` research and hero talents, `[26]` hero, `[30]` own army |
| 61000 | `[[]]` | the signed-in account's own artifacts (ignores any argument) |
| 312 | `[[[tileIds], [versions], [], []]]` | map objects per 20×20 tile; `tile = floor(y/20)*50 + floor(x/20)` |
| 23 | `[[kind, count, [], false]]` | the kingdom's clan ranking `[[clanId, value], …]`, unsorted; kinds 7 wealth, 1 might, 3 valor, 4 conquest, 5 crypts |
| 24001 | `[[[[playerId], [clanId], realm], []]]` | every event (tournament) the realm knows: body[0][0] `[[type, run], occurrence, state, endsAt, …, startsAt]` (state 1 = running; endsAt 4294967295 = open-ended; occurrence = which time the event came round, e.g. Rise of the Ancients #242). body[0][1] lists `[type, run]` only |
| 38003 | `[[[type, run]]]` | the event window's **Clan members** tab for the account's clan: body[0][0] `[[playerId], points, rank]` per member. Verified Nov 17 2026 against the game (SIK's Rise of the Ancients: Mr Freeze 52,586,600 #1, Daigor 50,047,641 #2, Fiin SK 2 49,899,136 #3) |
| 38000 | `[[[type, run]]]` | the event window's header for the clan (asked as the window opens, before 38003). Rise of the Ancients: body[0] `[[occurrence, bossId, summonsLeft, 0, [0], [0,0,0]], {artifactId: [level, points]}]` — bossId is the clan's Ancient (T44 f9 `clanBossAtoms` 6000–6249), summonsLeft the window's "Summons left" (CWB 2, SIK 1 on Nov 17 2026, as the game showed), the map the clan's artifacts (1 Tome of Knowledge, 2 — 4 in the Seasonal Kingdom run — Enchanted Figurine, 3 Mysterious Clock; SIK's Tome 26 / Clock 16 match its screen). Fields 3–5 not decoded |
| 15200 | `[[[clanId], …]]` | clans' headline: logo, tag, name, members / limit, might |

Gifts: lifetime 20 h (arrival = expiry − 72000 s). `tab` 1 = Gifts, 2 =
Triumphal; `count` is chests in the entry (Bank bundles 3 or 30). Gift ids are
sequential per clan, so gaps are losses. Ledger kinds seen: 4 donation (res 20
Scientific Tractates, 31 Dragon Coins, 21–23 Boards/Cement/Steel, 74284 Magic
Seeds), 7 Forest Essence (74285), 3 basic resources (2–6), 2 speed-up with item
counts (2050 1h, 2051 3h, 2052 8h, 2053 15h, 2054 24h, 2055 72h).

## Event standings (v121)

Every scan, per clan ([`collectEvents`](../src/scheduler/game-protocol-phase.ts)):
24001 lists the events the clan's account sees; each **running** one (state 1,
not past its end) is asked for its Clan members tab (38003) — the requests the
client sends when an event window opens, read-only, one per running event
(~10 on a normal day). No per-event code: whatever runs is stored per run
(`game_event_runs`, keyed type + run + occurrence, so a finished run keeps its
standings), each player's latest points and rank (`game_event_standings`) and a
`game_event_standing_history` row only when the points move (the first read is
the baseline). An event without a clan-members tab answers nothing and is
skipped. Raw replies are archived (`event_list`, `event`).

Titles come from T44 (`names.json` `events`, "type,run" → code, title key,
English title). A run maps onto the site's events by its English title against
the catalog's `calendarNames` / name, case- and accent-insensitive
([event-mapping.ts](../src/game-protocol/event-mapping.ts)): Rise of the Ancients
and Ancients' Treasure → ancients, TRIALS OF OLYMPUS → olympus, DARK OMENS →
dark-omens, Ragnarök → ragnarok. Anything else (Trade Routes, Summon Mastery,
Prime Arena, …) is stored and shown under the game's own title.

Shown: a "Standings from the game" card on the event's page (the run the
selected timeframe covers; the hand-pasted standings card folds away under it),
and **Events → In-game rankings** — the latest run of every event read. On
**Events → Ancients** the Tin Man card itself is the game's per-summon table
(below).

### Rise of the Ancients per summon (v124)

Rise of the Ancients is read with its window header (38000) right before its
standings, every time ([event-read.ts](../src/scheduler/event-read.ts)), and
every read — scan or poll, any event — gets a `game_event_reads` row: when,
members, total points, `changed` (members whose points moved since the run's
previous read; 0 = flat), summons left, the Figurine's summons, used (= max −
left: the read's summon tag), boss. A member's points at a read are their newest
`game_event_standing_history` row at or before it (both carry the read's
timestamp).

- **"of 2" is the Enchanted Figurine.** The game's label is "Summons left:
  %num%/%max%"; artifact 2's effect is "Number of summons". Its level is the
  summon count, not a step on the 28-level cost ladder the Tome and Clock share:
  CWB's Figurine had 6,156 points in (ladder level 4) yet reported level 2, and
  both CWB and SIK showed "of 2" at level 2 ([ancients.ts](../src/game-protocol/ancients.ts)).
  T44 f9 `attempts` is 1 here and 5 in the Seasonal Kingdom run ("Increased
  starting summons!"), which no read has checked yet, so the total shown is
  never less than used + left.
- **Summons are windows** ([summon-windows.ts](../src/data/summon-windows.ts)):
  points grow only while a summon runs (1–50 min). One starts when summons left
  drops between two reads (with no summons left to go by: points moving after a
  flat read), and ends on a flat read, 50 minutes after it started, or at the
  next start. Its points = at its end − at the read before the drop. Back-to-back
  summons are split only when the reads separate them (a flat read, or 50
  minutes, between the first one's start and the read before the second drop);
  otherwise — or when two drops fall between the same two reads — they are one
  column, "S2–3", the total of both, as the leaders pasted it. Never an
  invented split.
- **Between scans** ([event-poller.ts](../src/scheduler/event-poller.ts)):
  while a clan's Rise of the Ancients runs, 38000 + 38003 again every ~10 min
  (~5 while a summon scores), on the game session the clan's last scan signed
  in with, kept in memory. Never a login: a failed or empty read drops the
  session until the next scan, and a scan drops the kept sessions of every clan
  on its account (its login supersedes them). Never while the clan's lane has a
  scan queued or running, the read itself queued on the lane; nothing while the
  login bridge has scanning paused (which drops every session). Ticks once a
  minute and reads on the last tick before the interval would pass, so reads
  are never further apart than the interval while the session lives.

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
| 9 | units | f1 name, f2 tier (0–10), f4 icon, f10 strength, f12 health |
| 21 | techs (research ~1000–1840, talents 25xxx/29xxx) | f1 name, f5 levels |
| 62 | clan medals | f5 vector (f4 unlock text, f6 tier) |
| 44 | events (tournaments), `$pairs` keyed `[[type, run], stage]` (asIdRecord joins it: "1024,1,1") | f10 config JSON → `info_title` ("global_tournament.client.value.clandoom_epic.info.title" = Rise of the Ancients) |
| 52 | customizations: f1 kind (1 portrait frame, 2 city look) | f2 name vector, f4 visual JSON |
| 75 | captains | `battler_unit.name.<key>` from f7's `animationLinkage` (`battler_<key>_unit`), else the f5 vector |
| 11 | equipment, one row per item type AND quality grade | f3 vector |
| 110–113 | artifacts (`$pairs` tables keyed `[type]`) | T110 f8 vector |

Equipment (T11): f1 set, f2 icon address (`arch_body`: set prefix + slot
weapon / head / torso / body / legs / trinket1 / trinket2), f3 name, f5
**quality grade** 1–8 (Poor, Common, Uncommon, Rare, Epic, Legendary,
Ascendant, Godlike — `client.craft.<gray|white|green|blue|violet|orange|red|gold>_item_title`),
f7 durability, f9 props JSON = the item's bonuses at that grade
(`equipment.client_info.n0001` is Durability). "Cursed Claw Coat" exists once
per grade: +3 % Crypt exploration at Poor, +50 % at Godlike. Gems (T8 f1 8)
and enchantments (T8 f1 9) are T8 items: f3 name, f6 `{"icon": …}`.

Artifacts: **T110** types (27): f7 `{"icon": …, "animation": …}`, f8 name, f9
tooltip, f11 rarity 4 Epic / 5 Legendary / 6 Mythic
(`client.artifact.window.artifact.<epic|legendary|mythical>_rarity`).
**T111** `[[type], {star: [star, bigStar, effectId, cost, propsRef, …]}]` —
25 star levels, five per displayed star. **T112** `[[type], xpItem, {level:
[level, effectId, cond, xp, propsRef, …]}]` — 60 levels. **T113** `[[type],
{effectId: [weight, propTextRef, valueTextRef, quality 1–5]}, unlocks]` — the
random-bonus pool. **T20** effects: f3 `[[kind, propertyId, [], [2747], 0,
value, 0]]`, value a multiplier ×10000 (20000 = +100 %). `readTables` re-keys
`$pairs` tables by their id so they read like the others.

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
