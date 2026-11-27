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
   THEN claims them (15013, `{giftId: n}` — n chests of that entry): Gifts-tab
   chests one request per chest TYPE, every entry of that type asked for with
   its chest count, like the game's own "Claim chests" — at most 100 entries /
   100 chests a request, a bigger stack split across requests
   ([claim-plan.ts](../src/game-protocol/claim-plan.ts); SIK's 49 singles took
   ~15 s one by one, its 473 stacked summon chests 462 requests / ~100 s until
   Nov 17 2026); Triumphal chests one chest per request like the Open button
   (a 3× bundle is three, as captured); a refused request is retried chest by
   chest; each request's (summed) rewards → `game_claims` with `batch_size`
   (chests) / `gift_ids` (v109) — the scan card counts chests, not entries —
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

Names: the game's own, written verbatim — nothing maps them onto older
spellings (Nov 25 2026; v139 moved the OCR era's "Lvl 25-29 Vault of the
Ancients" and the like onto the game's "Level 25–29 …"). Point values key on a
slug derived from the source name (`getSourceKey`), which those renames left
unchanged. (Chest/source merge rules applied here until Nov 25 2026.) A chest's type (common … legendary, arena) stays the site's
own `CHEST_TYPES`, not the item quality grade (T8 f10), which follows the crypt
level rather than the chest — see [chest-identity.md](chest-identity.md#chest-types).

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

### Chest rewards (its own menu entry, #chest-rewards)

`game_claims` keeps the game's own reply to every claim request: `rewards` is
`{itemId: amountOrCount}` SUMMED over the request's `batch_size` chests of one
`gift_type`. [`data/chest-rewards.ts`](../src/data/chest-rewards.ts) turns it
into the tab's two views (`GET /api/resources/chest-rewards?from&to&trendFrom`,
clan-scoped, at most 62 days, `pages/resources-chest-rewards.js`):

- **Income** — the period's totals per reward and a per-game-day trend
  (17:00 UTC rollover, never calendar days). Units never mix: a base resource
  (T8 id < 100 without a quality grade: Gold, Silver, Tar, Dragon Coins,
  Sacred Potion …) is an amount; a **fixed resource pack** counts as that
  amount of its resource (shown apart as "from packs"); Speedup, Clan Speedup
  and VIP status are total **time** (count × duration, one total per kind);
  anything else (boosters, March Speedup, forge materials, pincers) is a
  **count** of that item — never a guessed amount.
- **By chest** — per `gift_type`: chests opened, average per chest =
  SUM(rewards) / SUM(batch_size) (never a mean of request means), and the
  **drop rate** = share of single-chest claims (`batch_size` 1) that held the
  reward. A stack's rewards come back summed, so stacks count toward the
  averages only; a type only ever opened in stacks has no drop rate ("—").

What an item is worth comes from T8 (names.json `items`, NAMES_FORMAT 10; see
GameItem in [static-data.ts](../src/game-protocol/static-data.ts)): f1 kind,
f10 quality grade, f8 a speedup's seconds (kinds 3, 11), f12 VIP status's
seconds (kind 6), and f7 — `[[entry…]]`, an entry `[[condition], weight,
payload, 0]` with payload[0] `{resourceId: amount}`. One entry granting only
base resources (payload [1] units, [2]/[3] items, [9], [11] timed effects,
[15] all empty) is a fixed pack: "Silver" 1123 = 250,000 Silver, 1361 =
5,000,000; "Lumber" 1567 = 250,000 Lumber; "Dragon Coins" 2406 = 1,000.
Several entries are a weighted draw (a chest) and stay a count. All 84 pack
ids and 16 duration ids prod's first day of claims held resolve this way.

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
asset addresses inside). Only bundles holding images we select are downloaded
(heroes, portrait frames, city looks, troops/mercenaries, research/talent
icons and every tree's own picture, chests, resources, clan, events, status
icons, … — then the two catch-alls below),
decoded (UnityFS + LZ4 → SerializedFile type trees → Texture2D RGBA32 / RGB24 /
RGB565 / DXT1 / DXT5, Sprites cut from their atlas — pixel-identical to UnityPy
on 2188 references) and written as PNG to `data/game-art/<catalog>/` with an
`index.json` (images + mappings). Runs at startup and daily; a new catalogue
re-downloads only changed bundles; current + previous version are kept.

**Extract before a page needs it** (selection 12, Nov 18 2026). My Clan showed
"Clan territories" without its picture: the tree's `visual` (`clan_fort_4_72`,
T1 client config) was never selected, because a picture was only extracted once
some category "wanted" it. Now, in [selection.ts](../src/game-art/selection.ts):

- **By construction from the static data**: every tree's picture (T1 branches,
  `ArtStatic.branches`, format 5 — research, talents and clan; the audit also
  caught `tech_guards_new`, `tech_army_new`, `tech_beasts_new`), and every sprite
  name names.json carries, found by key wherever it sits (`named`,
  `artNamesFromGameNames`, keys `ART_KEYS`). A test scans static-data.ts so a new
  art field on a `Game*` interface must be collected. On the live data all 818
  names.json sprite names the catalogue lists are selected; 6 it names aren't in
  the catalogue at all (`lvlup_heimdall`, `lvlup_artemisia`, `lvlup_attila`, two
  artifact icons, `bonus_adept_fire_28`).
- **`icons`, the catch-all**: every catalogue address that is a UI icon by its
  name — size-suffixed sprites (`_72`, `_28`, `_22`, `_64`, …) and `icon_*` /
  `*_icon` — minus animations, audio, per-language pictures, banners, the world
  map and minimaps, tutorials and `_old` copies; at most 512 px a side
  (`LIBRARY_MAX_SIDE`; bigger ones are recorded as skipped). Measured on catalogue
  c508dcac… (14,384 bundles, 15,554 addresses):

  | Rule | Adds | Bundles | Download | On disk |
  |---|---|---|---|---|
  | size-suffixed sprites | +1,837 | 1,806 | ~46 MB | ~19 MB |
  | `icon_*` / `*_icon` | +741 | 741 | ~87 MB | ~21 MB |
  | *not taken:* `_frame/_back/_mask/_lg` backgrounds | +361 | 201 | ~873 MB | ~894 MB |
  | *not taken:* `_scaled` full-body pictures | +262 | 262 | ~542 MB | ~184 MB |
  | *not taken:* everything but known non-pictures | +7,940 | 6,995 | ~3.3 GB | ~1.2 GB |

  Selection 11 took 3,190 addresses from 2,977 bundles; selection 12 takes 5,416
  from 5,168. The first run per art version downloads the ~2,200 new bundles
  (~130 MB, a few minutes at 6 at a time; ~12 ms CPU each) and copies the rest.
- **Best effort, never fatal**: a `named`/`icons` bundle that fails is counted,
  not held against the run (only bundles with a picture the app shows count
  toward the 20% abort). A bundle that couldn't be **downloaded** goes on the
  index's `retry` list — the next run with the same art and selection rebuilds
  to fetch just those, reusing every image, instead of keeping the hole until
  the next game patch. Addresses with no picture in their bundle, or too big,
  go on `skipped` and aren't downloaded again.
- **Holes are logged**: `gameArtUrl` asked for a name the index doesn't have
  logs it once per name per art version, batched to one informational
  (noAlert) line a minute, split into "in the catalogue, not selected" (the
  selection should take it) and "not in the catalogue". The run writes
  `catalog-names.txt` beside `index.json` for that (not served: only `.png` is).

This is the one Unity reader: the research and talent trees' layouts (JSON
TextAssets, "guardtree" …, [tech-trees.ts](../src/game-protocol/tech-trees.ts))
are read with it too — `nameIndex` finds the bundle by the asset's name,
`extractTexts` the TextAsset through the SerializedFile's type tree. A second,
heuristic reader (`game-protocol/unity-assets.ts`, which scanned the raw
payload for length-prefixed JSON) was removed in Nov 2026 after both gave the
same 24 live layouts.

**Whose tree it is** is the client config's, not the layout's name: a tree in
an Academy tab (`academy/branches` tabs: "Unlock", "Boost", and since Nov 25
2026 "Clan Duel") is the player's research, whatever its layout is called — the
Clan Duel trees' layouts are `clanDuelTree27` / `clanDuelPowerTree28`, yet they
cost the player's Battle Crests (item 9270000) and need the player's Capitol
(building 15) at level 9, where the clan's trees (Clan territories, Allies)
cost Scientific Tractates (item 20) and need clan building 10003. Only a tree
outside the Academy named `clan…` (or of type `clanTalents`) is the clan's.
**A tree keeps the research its layout doesn't place** (`unplaced`, every
non-retired T21 tech of its branch, T21 f4): a patch ships research before the
client draws it — Army boost had 104 techs and a layout of 36 on Nov 25 2026.
The Research pages draw `nodes` only; Tools → What's new lists the rest.
`TREES_FORMAT` (2) rebuilds an older cached tech-trees.json once.

### Research levels, costs and units: the static rows by field name

The client's IL2CPP metadata (`StaticAll`, see "How it was found" under Hero
levels) names the fields; read Nov 26 2026:

- **T21 Techs** row `TechStatic`: `[techId, name, description, visual,
  branchId, …, levels]` — f5 levels `{level: TechLevelStatic}` =
  `[level, effectId, factoryPosId, conditionLearn [refs], clientInfo (props
  JSON: the level's bonus lines, and a "1_power_22" line = its Might),
  ratingContribution (Might per level), cronId]`.
- **T12 Factory** row `FactoryPosStatic`, keyed by a level's `factoryPosId`:
  `[id, positionType, price [{itemId: amount}, {}, 1], reward, conditions…,
  …, f7 produceTime (seconds, before speed bonuses), …]`. Research is paid in
  T8 items: Valor points (8) and Conquest points (9) for the player's trees,
  Scientific Tractates (20) for the clan's, Battle Crests (9270000) for the
  Clan Duel ones. Guardsmen's training cost I: 300 Valor / 300 s at level 1,
  450,000 / 36 h at 10 — Tools → Costs' sheet agrees.
- **T8 Items**: f3 the name vector, **f4 the item's own description** ("Skylands
  Points: Earned by collecting Campaign Chest rewards. Needed in order to
  research technologies.") — not `item.tooltip.<the name's code>`, which for
  the resources is another item's text (Valor points: name n0040, tooltip n0285).
- **Built every patch** with the trees ([tech-trees.ts](../src/game-protocol/tech-trees.ts)
  `buildTechLevels`, `TREES_FORMAT` 3): `tech-levels.json` beside
  `tech-trees.json` — per research every level's cost, time, Might, bonus lines
  and building ("Needs the Capitol building at level 9"; building 1 is the
  Academy *building*, levels 1–45, not the research screen), the currencies'
  names and descriptions. Served per tree (`/api/game/tech-trees/:id/levels`,
  a node's panel on the Research tabs and in What's new) and whole
  (`/api/game/research-costs`, Tools → Costs, which until Nov 26 2026 was a
  hand copy of kingdom289.com's sheet — the game's numbers agreed with it
  where the sheet wasn't wrong).
- **What a tier costs** ([tier-costs.ts](../src/game-protocol/tier-costs.ts), Tools → Costs'
  calculator): every level records the research it asks for (`needs`,
  `[tech, level]`; conditions are never OR'd, a `!HasTech` only means "not this
  level yet"), so "G5 → G6" is exact: what tier 6's unlocks need, level by
  level, beyond tier 5's — the unlocks plus training cost IV and march speed IV
  (102B Valor for all four G6 units, 75.36B for one: 9B + 2 × 33.18B, as the old
  sheet had it). What no tier needs is optional where it opens (carrying
  capacity, captains — the "only 2 of 3 are needed" rule, from the game).
  Tiers are troop-tiers.ts' (II trees continue at 8, crypts = numeral × 5).
  Research time is before speed bonuses; the page divides by the reader's bonus.
- **From where you are** (`tiersForPlayer`, `/api/game/research-progress`):
  an account linked to a game player gets that player's levels taken off every
  step — what is LEFT, item by item ("Lv 9–10, you have Lv 8"), each unit alone
  and the optional research too — and their tier the site's way (highest unit
  unlocked). Steps still add up: every step up to tier N is everything N needs
  minus what they have. Tools → Costs starts each line at "You now (G8) → G9",
  shows the tiers on the line buttons, and "Reset to my in-game research"
  appears once the reader picks another range. Only the caller's own players
  (alts: a dropdown, `?player=`); the same response carries the clan's levels,
  which tick off the clan trees in "Every research". The levels are the last
  daily research read — research since then isn't counted yet.
- **Live yet?** `/api/game/tech-tree-status`: per tree whether any player (a
  clan, for a clan tree) the site reads has a level in it, and since when this
  install has seen it in the data ([tech-first-seen.ts](../src/game-protocol/tech-first-seen.ts),
  `data/game-static/first-seen.json`, back-filled from every cached copy — the
  game's files carry no dates, so it is "since at least"). Modernization II:
  in our first copy (Nov 18 2026), 0 of 380 players started by Nov 26, paid in
  Skylands Points.
- **T9 Units** row `UnitStatic`: `[unitId, name, tier, texts, smallVisual,
  bigVisual, priceHospAttack, priceHospDefend, isWall, hospDefenderCooldown,
  attackPower (strength, f10), scoutPower, health (f12), crit, food,
  leadershipSupply, masterySupply, dominanceSupply, speed, loadCapacity, …]`
  — f10 and f12 are verified (art-static.ts); the rest are named by the
  metadata, not yet checked against the game's screens.

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
- **Item tiles** (chest rewards and chests, `itemFrames`; selection 10): the
  inventory / reward-window look — a 72×72 back
  `back_icon_subject_72x72_<colour>` coloured by the item's **quality grade**
  (T8 f10, the forge's ladder: 1 grey, 2 white, 3 green, 4 blue, 5 violet,
  6 orange, 7 red, 8 gold — "Rare Jewelers' Pincers" is 4, "Legendary …" 6,
  Wooden … Magic Chest 3 … 8), `back_icon_resources_72x72` for an item
  without a grade (resources, packs, speedups), the icon, and the bronze
  `frame_icon_thing_94x92` centred 2 px low. Which view picks which back is
  client code; the grade → colour rule is the forge's
  (`client.craft.<colour>_item_title`). Most item icons are opaque squares
  that cover the back; cut-outs (Gold, materials) show it. Drawn by
  `itemIconHtml` / `rewardChipHtml` / `chestIconHtml` in `lib/game-art.js`
  (geometry: style.css "Game item tiles"); a missing icon is a neutral
  letter tile, a missing frame the bare icon.
captain portraits from T75, artifact icons from T110's config (`artifacts`),
equipment icons from T11 f2 (`equipment`) and gem / enchantment icons from T8
(`inserts`), titles' round icons (`titles`, T29 smallIcon — sprites of the
`icons_title_small` atlas) and 72 px pictures (`titleArt`, mobileIcon;
selection 11), and the Ancient planner's pictures (`ancients`,
`EVENT_ART` in [selection.ts](../src/game-art/selection.ts)).

**Chest art across the site** (by chest name, `mappings.chests`; ~99% of
recorded chests have a picture). Every list of chests puts the bare icon in
front of the name with `chestLabelHtml(chestName, labelHtml, { size })` — no
tile: at table sizes a frame is noise, and only the Chest rewards tab knows a
chest's quality grade (it draws framed, graded tiles, `chestIconHtml`). The
label keeps the page's own markup (link, ellipsis, name-over-source stack), so
locked columns keep their widths. Sizes: 22 px in table rows, 28 px beside a
two-line name, 20 px in drill-down sub-tables, 16 px in a phone row's summary
line and in chips, 44 px on the chest's own page. Shown on: Home Recent
Chests; Scan History session detail (chests + triumphal); Triumphal Chests
recent list; member profile History (chests + triumphal tabs); Analytics →
Breakdown → Chest (the icon replaces the type dot; the bar keeps the type
colour), the `#chest/<name>` page header, and a source page's per-member
records; Events per-member drill-down and the Finish Reward card (event
columns carry `chestName` for info cards; 🏆 when the art lacks it); the
Leaderboard FAQ points guide (also on the public share page); Admin → Review
(new chest names, new triumphal chests, unread-name rows) and Admin → Points
(Chest Points chests and chips, Triumphal Chest Points). Left as text: `<option>`
lists, merge-rule tables (mostly OCR misreads), sentences (audit log, FAQ
footnotes), CSV/clipboard exports and Discord. Without an art index, or before
it loads, the label is the plain name; pages await `loadGameArt()` before
their first render. A chest the art lacks gets the neutral letter tile, so a
column still lines up. Resource icons (`resourceIconHtml` / `resourceIconOnly`
in `lib/resource-format.js`) sit beside resource names the same way, and also
lead the Resources overview's per-resource headings and the Rewards tool's
Dragon Coins pot.

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
plain `map_clan_doomsday_boss_scaled` (the event map's boss art). The Hall of
Fame's faction windows (`stainedglass_red|green|blue`, `FACTION_WINDOWS`) are
the same kind of still: the window is region `redv` / `greenv` / `bluev`, the
rest of the atlas its glow frames.
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
`x`, `y`, `realmId`, `staticId` = T7 map object — for `tile` a T4 TERRAIN type, the
id spaces overlap — `name`), `raid` (`created`,
`targetStaticId`, `name` = who), `clan` (join / leave / kicked with `kicker` /
archived), `journal` (attack / crypt / scout / clan_announcement / pvpladder —
a shared report, `name` = its subject, `journalV2EntryId` = what the journal
service opens it by: [battle-reports.md](battle-reports.md)), `spawn_sabotage_spawn_to_enemy`
(`spawnerName`, `staticAtomId`, `targetClanName`, `atomCoord`), `clan_spawn`.
`custom_type` `service` = the game's own posts (raids, joins…). The sender's
`sender_info` (`realm,playerHex,clanHex,0,rank,tag`) gives the player id
(`sender_player_id`) and the clan rank when the message was sent.

The page writes a location as the game does (`client_config.value.poi.copy_coords.*`):
"Player's portal NAME" (user, staticId 4), "Player's City NAME" (other user),
"<object> CLAN" (clan: "Clan Capital …"), the terrain ("Dense forest", T4 f2 via
`names.json` `terrains`) for a tile, else its name — every label an official
game text (tGame).

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
  First link: exact name, else a new member under the exact game name (the
  fuzzy-name-plus-might step for OCR misreads and the player merge rules were
  removed Nov 25 2026 — every live clan's members were linked by then, and the
  player id follows a player through every rename). Linked members take the
  game's spelling (old name kept as an alias, `rename_member` audited with
  `source: 'game'`) — unless an admin renamed the member by hand, which wins;
  the game's spelling is always kept as an alias. The Admin
  review queue's "Likely Renames" (a might/level guesser, v92) was retired in
  Nov 2026 (v120 drops its table): the game reports renames through the player id. They get `clan_role`, are marked
  seen and get the day's might + hero-level snapshot. With a roster of ≥ 5,
  every ACTIVE member the roster does not account for is removed (soft delete,
  `member.left_clan` audited with `linked: true|false`): players who left,
  and unlinked rows from the OCR era/old spellings.
  `[Unknown]` is exempt. Gift senders and ledger players outside the roster are
  credited through `makeMemberResolver`, which never reactivates anyone.
  A second account is its own member, linked to its own player id.
- **reads map tiles** around members' cities ([map-plan.ts](../src/scheduler/map-plan.ts)
  decides which, 9 per 312 request): every member's own tile, every scan;
  the tile of each member vault still standing at the last pass (its "last
  seen"); and **only while vaults are being raised** — Ancients' Treasure
  (event type 1023, `clandoom_preparation`, the run's first day) is in this
  scan's event list, ended under 2 h ago, the list couldn't be read, or a
  vault nobody had seen turns up on a tile read anyway — the ≤ 4 tiles within
  `VAULT_RADIUS` = 10 squares of the city of each member **without a vault
  yet**. A vault goes up by itself within 8–10 squares of the raiser's city
  (the user, Nov 20 2026), and a player raises one a run, so a member's tiles
  drop out the moment their vault is seen: on an earlier scan that run (30 h
  lookback) or an earlier batch of the same pass. Vaults plus member-owned
  objects on those tiles go to `game_map_objects`. A vault's owner (`[9]`) is
  the player who raised it; it lives 24 h (`[10]` expiry, unix seconds) unless
  taken down first. (Until Nov 20 2026 the full 3×3 around every city was
  read every scan; in 3½ days it found one other member-owned object, a Mimic
  Chest.) **Events → Ancients → Vaults** shows who raised one in the selected
  run — vaults first seen in its window (`GET /api/tinman/vaults?from=&to=`,
  `listRaisedVaults`) with first seen and a take-down mark — green ✓ once it
  is gone, red ✗ while the newest map pass still saw it (`standing`: its
  `last_seen` ≥ `MAX(game_players.map_seen_at)`, which the pass stamps with
  the same time; hover = last seen, so the take-down came after it) —
  members without one, and how
  many vaults of players outside the clan were seen nearby. A vault raised and
  taken down between two scans is never seen. With a **vault chat** picked
  (v144 — CWB's "-CWB VAULTS-", where everyone links the vault they raised),
  the view also says who posted theirs (✓/✗) and lists vaults posted but never
  seen on the map: [battle-reports.md](battle-reports.md#vault-chats). Each tile's `[4]` lists its **cities** (43-field
  records: `[0]` city id, `[2]` owner, `[3]` 2, `[4]` clan, `[13]` level,
  `[17]` `[realm,x,y]`, **`[25]` 1 = burning (walls down)**, **`[39]` true =
  shield**), confirmed by the user against the map (Nov 2026). Members' state
  goes to `game_players.shielded/burning/map_seen_at` with a
  `game_city_status_history` row whenever it flips (v112); the profile, the
  public card and the Members list show it.

Once per game day: every member's city (601: research + talents into
`game_player_techs`, with `game_player_tech_history` rows only on change;
captains into `game_player_captains` (v108); buildings + the DRAGON (field 26,
in the column named `hero` before that was known) into `game_city_snapshots`; ≤ 120 cities a cycle, **20 per 601 request** — the game
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
| 0 | hero id in **T10 (Heroes)**: 1 is the hero, every other id is a captain and equals its T75 id. The hero's entry is stored too (since Nov 2026, for its level / XP and gear) but writes no captain history |
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

### Speeds (city field 14 + T20)

The game's Statistics page ("Research speed: 2026.3%", construction, troop
training) is the sum of the city's effects, so it is worked out for **every**
member ([city-speeds.ts](../src/game-protocol/city-speeds.ts)) and stored per
city read in `game_city_snapshots.speeds` (v141; the archive replay fills the
60 days of reads it keeps). **T20** f3 entries are `[kind, textRef, [],
[cond], 0, value ×10000, flat]`: kind **0** construction speed, **2** troop
training, **17** research; `textRef` is only the line's text, except that a
training line with a troop type's own text ("Guardsmen's training speed")
applies to that type alone — the general text is the one every research line
uses. names.json (format 13) keeps `speeds.effects` (effect → [c, t, r] %) and
`speeds.techs` (tech → level → effect).

Field 14's source bits: 2 research and Hall of Fame, 4 the main buildings at
their level (Academy 45 = +300 % research), 32 Barracks and walls (T17), 16
gear with its gems and enchantments (the hero and the three line-up captains
only — a benched captain's preset is not in field 14 and not in the game's
total), 128 captain levels and star levels (one captain's level = +1 %
research per level), 256 titles, 1 / 8192 / 16384 artifacts, 2048 / 4096
shop offers. **Not in field 14**: VIP (tech 1000, the player record's level:
+33 % at VIP 21) and the clan's research (10113 / 10130 "Research speed": +50 %
at level 10) — both added by level. Checked on Nov 26 2026 against a member's
Statistics page: 2016.25 vs 2026.3 (research), 1335.75 vs 1345.8
(construction) — the same +10 % on both from a boost that runs out (the clan's
7-day bonus items, `clanbonus13/14`, or a speed item: neither reaches the
site); training 2249 vs 2374. The game rounds to one decimal. Members →
profile → Speed bonuses shows the three, where they come from and every
change; Tools → Costs fills the reader's research speed from it.

### Every bonus (city field 14, named)

Beyond the three speeds, every bonus a city has is kept per read
(`game_city_snapshots.stats`, v142; [city-stats.ts](../src/game-protocol/city-stats.ts)):
production per resource, storage, strength / health / march speed / carrying
capacity per troop type, training cost, crypts, points, the captains' stats…
— ~105 for a developed city, shown under Members → profile → City bonuses with
every change between reads.

T20 lines carry no text; the game prints them in its windows, in the effect's
line order: a research level (T21 levels `[1]` effect, `[4]` props), a hero
or captain level (T10 f7 `[6]`, `[7]`), a captain star level (T75 f12 `[6]`,
`[7]`), gear (T11 f6, f9), an artifact star and level (T111 `[2]`, `[4]`; T112
`[1]`, `[4]`). Pairing those (same number of lines, every value agrees) votes
a text key per (kind, target). **Read by position**: a row's other numbers
(levels, price ids) are often ids of effects AND of props strings too —
walking rows generically paired the wrong lines. Only a line whose value no
other line of the effect shares votes (VIP prints its dozen "+1 %" lines in
another order), and a text belongs to the kind most of its votes came from.

`target` is a VECTOR of ids — units, resources (2 Silver … 6 Food, 13 Tar),
crypts; empty = everything. Its pool index moves between patches, so stats are
keyed by the text, `"kind:English label"` (the kind keeps the clan's own
"Research speed", kind 48, apart from the city's, 17). A line aimed at several
resources is split into each one's line, so "Food production" holds everything
that raises food. The clan's research only adds to bonuses the city already
has (the rest of it is the clan's own). Checked: the three speeds come out of
this exactly as city-speeds.ts has them. names.json format 14 (`cityStats`,
~1.4 MB: 47k effects); texts-<lang>.json translates the labels.

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
level plate, level / XP from this field-9 entry — the player record's hero
level until a city read stored it — and its gear).

The hero's detail matches a captain's: XP to the next level, "Tracked since",
level-ups (from `game_player_history.hero_level` — the hero writes no captain
history) and **all six gear slots**, empty ones as bare frames. Slots come from
`HERO_GEAR_POSITIONS` (0–5) and `CAPTAIN_GEAR_POSITIONS` (3–5: prod never had
a captain item elsewhere). The level shown is the player record's (read every
scan); the entry's XP only counts while the entry is at that level, else the
dialog says the XP comes with the next daily city read. The hero's entry was
only stored from live reads until the `heroEntry` city parser (Nov 2026)
filled it from the archive — newest read wins whatever the order, earliest
read is first_seen (`saveHeroEntryFromArchive`). No Stats block for the hero:
the game's hero Stats add research and gear to the level's values.

**City field 26 is the DRAGON, not the hero** (found Nov 2026; it was read as
"hero" since v103). Its XP sits on **T73 (Dragons)** thresholds to the unit:
prod rows at `{"level":100,"xp":1404294900}` and `{"level":150,"xp":17020294900}`
are dragons parked at exactly the level-100 / 150 threshold (an evolution cap),
the user's "Salty" is level 237 with 1,258,975,435,937 (T73 L237 1.2157T ≤ xp <
L238 1.2699T), while `game_players.hero_level` disagrees with it everywhere.
`CityRecord.dragon` now; the snapshot column keeps its old name `hero`. See
[The Dragon](#the-dragon-city-field-26-profile--captains).

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

**Levels, XP and the Stats screen come from T10 (Heroes)** — the hero and
every captain is a row there (key = the field-9 id; f1 type 0 hero / 1
captain; f15 battler unit = the T75 id). f7 is 600 level rows
`[level, expRequired, reward, leadership, authority, dominance, effectId,
clientInfo, ratingContribution]`:

- `expRequired` is the cumulative XP the level starts at (past 2^53, from about
  level 450, the codec hands `"…n"` strings). All 6,179 captains on prod sat
  inside req(level) ≤ xp < req(level + 1). Carter level 201 starts at
  646,229,682,960; the game's "12,954,943,875 to the next level" was taken 150
  XP after our read (XP moves every battle). All captains share these
  thresholds (two series differ by rounding only, from level 411); the hero
  has its own (level 214: 2,281,050,768,780 – 2,395,050,768,780).
- Leadership / Authority / Dominance are stored ×100: Carter level 200 has
  4,000,000 / 2,000,000 / 1,000,000 — the Stats screen's 40,000 / 20,000 /
  10,000. The same for every captain at a level.
- **Might** = the sum of `ratingContribution` over levels 1…L + the current
  star row's T75 f12 `[8]` (not cumulative): Carter 2,500,000 + ★6 270,000 =
  2,770,000, exactly the game's. The per-level Might differs by captain group.
- `clientInfo` is the level's "Features" props (Carter 200: Crypt exploration
  efficiency +200 %, Tar capacity +200 %) — not shown yet.

names.json (format 5) keeps them as `heroLevels` (each distinct series once,
~70 KB) and `captains[id].starMight`; `heroLevelView`
([hero-levels.ts](../src/game-protocol/hero-levels.ts)) turns a level into the
XP window and the Stats. The dialog shows the game's XP bar ("13B to the next
level") and, for captains, the four stats; the hero gets the bar only (its
in-game Stats add research and gear).

How it was found: the per-level ranges measured from prod's (level, xp) pairs
matched no number sequence the table walker could see — T10's levels are an
ARRAY of rows, not a level-keyed map. The client's IL2CPP metadata
(`Il2CppData/Metadata/global-metadata.dat` inside Triumph.data) names every
static table: `Rk.Rubens.Generated.StaticAll`'s 226 fields are the tables in
file order (T10 Heroes, T13 Avatars, T73 Dragons, T75 BattlerUnit, T112
Levels, T195 ArmiesPresetCaptainPowerCalculator, …) and each `*Static` class
lists a row's fields (`HeroLevelStatic`: _level, _expRequired, _leadership,
_mastery, _dominance, _effectId, _clientInfo, _ratingContribution;
`BattlerUnitLevelStatic` = T75 f10: attack, hp, defense, …, power). Reading
them needs only the metadata (version 31): header pairs of (offset, size)
from byte 8 — strings 3rd, fields 12th, type definitions 20th — type
definitions are 88 bytes (name, namespace = string indexes; fieldStart at +32,
field count u16 at +68), field definitions 12 bytes (name index first). A
machine-local reader lives under the gitignored `research/`.

Not read yet: the level "Features" (above) and the instance fields a, b, c of
an item.

### Hall of Fame (techs 800–803, profile → Captains)

Nothing new is read: **a faction's level is a city tech** (field 17, already in
`game_player_techs` with `game_player_tech_history` rows on change) —

| Tech | | Levels |
|---|---|---|
| 800 | Lions of Courage (T78 id 1, `courage`, red) | 180 |
| 801 | Wolves of Tenacity (T78 id 3, `tenacity`, blue) | 180 |
| 802 | Eagles of Resolve (T78 id 2, `resolve`, green) | 180 |
| 803 | Hall of Fame | 150 |

T78 is the faction table: `[id, …, f4 visual JSON, f5 tech id]`, the JSON naming
the art (`stainedGlass`, `icon`, `banner`, `frameIcon`) and the faction's text
key (`tooltipDescription` `battler_fraction.tooltip.<key>`; its name is
`battler_fraction.description.<key>`). T75 f1 is a captain's faction by the
same ids. Each tech level row in T21 (`[level, effect, …, [3] condition refs,
[4] props JSON]`) carries the level's bonuses (the same props JSON as captains'
star levels: "Army strength +41,25%", "Strength against players", "Authority"
for the Lions; Army health / Health against players / Dominance for the Wolves;
Construction speed / Research speed / Leadership for the Eagles; Conquest /
Valor / Experience points for the hall) and what reaching it takes:
`HasCaptainFractionRarityLevel(lvl, faction, rarity, count)` (rarity 2 = epic
and up, 3 = legendary and up; worded by
`client_config.value.conditions.has_captain_fraction_rarity_level.{epic,legendary}`)
and, for the hall, `HasFractionLevel(800,801,802,N)` (`client.conditions.has_fraction_level`,
"Required level of all factions: N"). The hall is found as the tech whose levels
require `HasFractionLevel`. T21's own names for 800–803 are placeholders
("Ranged units' strength I" …), so `buildNames` overwrites them with the real
ones — the Timeline names faction upgrades right (with the crest as icon; the
techs have no icon of their own), and the Research tab never lists them (not in
any tree). Verified against the game's screens (Nov 2026): Lions 55 → 56 is
"+41,25% > +42,0%" and needs 2 level-150 epic+ Lions captains; Hall of Fame
6 → 7 needs every faction at 46. Faction points (`item.name.courage_points` …)
are items — captains' star levels grant them — and are not stored.

[factions.ts](../src/game-protocol/factions.ts) `hallOfFameView` builds the
card (game order Wolves, Lions, Eagles; current bonuses, the next level's
values and requirement); the art is selection v8's `factions` category — the
stained-glass windows are Spine stills (regions `redv` / `greenv` / `bluev`).

### The Dragon (city field 26, profile → Captains)

City field 26 holds one entry `[1, [cityId], xp, level, stage, ?, name]` —
`{"1":[1,[1297100544969],1258975435937,237,6,false,"Salty"]}`: XP, level, the
**evolution stage** (1–8) and the **name the player gave it**
(`CityRecord.dragon`; stage and name parsed since Nov 2026). Nothing new is
requested: the daily city snapshot stores it (`game_city_snapshots.hero`, named
before the field was known to be the dragon), so there is one reading per
member per game day — the history the Timeline uses. No migration.

**T73 (Dragons)** is one row (key 1):

| Field | |
|---|---|
| f2 | 300 levels `{level: [level, xpRequired (cumulative), effectId, textRef, 0]}`; L237 starts at 1,215,710,294,900, L300 at 21,332,810,294,900 |
| f3 | 8 evolution stages `{stage: [stage, levelCap, cost, effectId, textRef, n]}`, caps 20 / 50 / 100 / 150 / 200 / 250 / 300 / 300 |
| f4 | the Dragon window's config JSON: `icon_frame_linkage` `frame_icon_red_dragon`, `background_linkage` `red_dragon_back`, title keys `client_config.value.feature_dragon.*` |

A level's text is `{"effect_strings":[{id, text, value}]}`, the bonuses AT that
level, ids 0–9: Army strength, Army health, Strength / Health against players,
Leadership, Authority, Dominance, Experience / Valor / Conquest points
(`client_config.value.feature_dragon.army_power_bonus` …); `value` is a percent
(L237: 114, 114, 99, 99, 15, 15, 15, 10, 8, 13; L300: 160 … 20). A stage's text
has the same ten lines — what that evolution gives (stage 6: +15% against
players, +5% for the other six non-army lines) — plus its sprites:
`icon_linkage` `icon_red_dragon_<s>`, `full_dragon_linkage` `red_dragon_<s>`
(also `_city`, `widget_` and march `_pet_` variants, not taken).

**A dragon at its evolution's cap gains no XP until it evolves**: prod holds
capped dragons at exactly the cap level's threshold (L100 1,404,294,900, L150
17,020,294,900). The game says so in its own words
("Raise your Dragon's evolution to unlock access to new levels.").

`names.dragon` (NAMES_FORMAT 9, [static-data.ts](../src/game-protocol/static-data.ts)
`buildDragon`) keeps the thresholds, the per-level and per-stage bonus values in
one fixed line order, the stage caps and sprite names (~14 KB).
[dragon.ts](../src/game-protocol/dragon.ts) `dragonView` builds the Captains
tab's Dragon card (below the Captains card): the picture on the window's
background, the name, "Level 237/250" (out of the evolution's cap, as the
game's "Lvl. 237/250"), evolution N of 8, the XP bar to the next level (or the
cap note, or "Reached the maximum level of the Dragon."), and the level's and
evolution's bonuses — a next value only on the lines it changes (one level up
moves one or two of the ten). The art is selection v9's `dragon` category. The
profile's Dragon stat (level + name) reads the same snapshot through
`/api/game/members/:id`.

Old snapshots carry level and XP only. The `dragon` city parser
(`CITY_PARSERS`, marker v1) replays the archived city replies once per clan
and rewrites each archived day's snapshot with stage and name
(`updateCityDragon`; a day without a snapshot row is never created).

**Timeline**: a `dragon` entry (group Growth) whenever a day's level or
evolution differs from the last day read — "Dragon level 236 → 237",
"Dragon evolution 5 → 6". The first reading is the baseline; a day with no
dragon read is a gap; a stage first seen on an old read is the stage's baseline.

The chat-level import that used to supply the Dragon level is retired
([member-levels.md](member-levels.md)).

### Titles (v125, profile header and Timeline)

The small round icons the game (and tbclanportal) shows beside a player —
"Prefect" from the Loyalty Bonus, tournament titles like "Blademaster",
Premium's "Great Marshal" — are **titles**. Nothing new is requested: two
replies the scan already reads carry the same entries
([titles.ts](../src/game-protocol/titles.ts); the client metadata names both
shapes — `UserShortInfo.Titles` / `TitleHistory`, `AtomClientDyn.Titles` /
`AtomTitleDyn`):

| Where | Field | Holds |
|---|---|---|
| player record (402), every scan | `[19]` | `[[titleId, assignedAt], …]` — the titles held now (`[]` = none) |
| | `[20]` | `[[titleId, count], …]` — how many times each title was ever received, held or not (`UserTitlePair`) |
| city (601), daily + archive | `[21]` | `{titleId: [titleId, eventId, assignedAt]}` — the same titles; `eventId` 51–54 on the normal realm, 0 in SK7, not decoded further |

`assignedAt` is when the player received it (unix s); it ends at `assignedAt` +
the title's `timeActive` (T29 f7) — Prefect 7 days, tournament titles 7–30,
the preseason's 89; 0 = no set end (the kingdom's palace titles, Premium's
three, which the game re-grants every few hours with a new `assignedAt`).
**The server drops a title once it runs out**: none of prod's 517 archived
city replies (Nov 16–17 2026) held an expired one, and 757 player records read
the same set as the city reply of the same player (the 368 that differed were
read hours apart: a Premium title had been re-granted).

**T29 (Titles, `TitleStatic`)**, 244 rows: f1 name vector, f2 the bonus text
(the game's own `\n` between lines: "+50% to Valor, Conquest, and Experience
point gain.\nThe title is active for 7 days after being acquired."), f3 visual
JSON (`smallIcon` — the round 28 px icon, a sprite of the `icons_title_small`
atlas — `bigIcon`, `mobileIcon` / `rewardIcon` 72 px), f4 effect, f5 hidden in
the palace, f6 max owners, f7 `timeActive` (s), f8 unassignable on voting, f9
client config JSON (`hideInTitlesHistory`, `hideInBoostersWhenInactive`,
`palaceSortIndex`), f10 main tournament title, f11 palace cooldown, f12 source
vector ("Received from the Loyalty Bonus", "Can be obtained from the Wargames
tournament."), f13 blocked by, f14 city visual. Id 29 is the Loyalty Bonus's
Prefect (604,800 s); id 28 an older "Prefect". `names.titles` (NAMES_FORMAT 11,
`buildTitles`) keeps name, bonus text, source, seconds and both icon names;
rows without English text (test rows) are left out.

Stored: `game_player_titles` — one row per **grant** `(title, assigned_at)`
(a title received again is a new row, so the table is the history), with
`first_seen` / `last_seen` and `gone_at`, the first read without it (it ran out
or was taken); `event_id` from the city reply. `game_player_title_counts` keeps
field 20's lifetime counts. `saveTitles` is replayable in any order: a read
older than a grant's last sighting, or from before it was received, never marks
it gone; first_seen only widens; a sighting after `gone_at` clears it. The
player record writes every scan (`savePlayers`), the daily city read adds the
event id, and the `titles` city parser (`CITY_PARSERS`, v1) replays the
archive once so history starts at the first archived read.

Shown **only on the member profile** — never in a list or table (user, Nov
2026): `GET /api/game/members/:id` → `titles` (`titleViews`: only titles still
running at read time, newest received first), a row of the game's round icons
after the game facts in the header (26 px; 22 px in a full row of its own on a phone),
each a button whose hover card (desktop) / dialog (click, tap, keyboard) shows
the 72 px picture in an item tile, time left ("6 days left", "3 h left"), how
long it lasts, the bonus lines, the source, received / ends, and "Received N
times in all" from field 20 ([member-titles.js](../src/web/public/pages/member-titles.js),
reusing the Captains tab's hover card). Names, bonus texts and sources go
through tGame; their es/fr/ru/de texts are the game's own, built with the
names like every game name ([i18n.md](i18n.md#game-names-tgame-the-games-own-text);
the game's plain quotes become the language's own). The art is selection v11's `titles` category
(mappings `titles` = round icon, `titleArt` = 72 px picture).

**Timeline** (group Titles, its own filter chip): a `titles` entry per game day
with one line per change, the round icon beside each
([member-timeline.ts](../src/data/member-timeline.ts) `titleChanges`):

- A title **with a set end**: "Received the title X" at its `assignedAt` (the
  game's own time, so a title already held at the first read still shows when
  it was received); "Received the title X again" when a new grant arrived
  before the last one's end (a tournament won again — the clock restarts, no
  end in between); "The title X ran out" at `assignedAt + seconds` once that
  has passed (the server drops it then); "No longer holds the title X" at
  `gone_at` when the first read without it came more than 5 minutes before its
  end (taken). Still running: no end line.
- A title **with no set end**: the game re-grants Premium's three every hour
  or two with a new `assignedAt`, and they take turns (Great Ruler → Great
  Marshal → Great Ruler within three hours on prod), so these count by reads:
  titles sharing a source are one holding while every read saw one of them (or
  the next was assigned before the last went). One "received" line at the
  holding's first grant; "No longer holds" at the first read with none,
  named by the title held last. Re-grants and switches are not lines.
- One line: shown as the sentence. Several on a game day: "Received 2 titles
  · 1 title ended", folded; each line keeps its own time; an ended title's
  icon greys out.

Prod, Nov 17 2026: 1,006 grants of 210 players → 638 day entries (447 of one
line), 902 received, 16 again, 1 gone; Premium's hourly re-grants add none.

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

### Joins & leaves (My Clan tab)

One clan-wide list of who joined, who left and who came back, newest first by
game day (`GET /api/game/clan/roster-changes?filter=joined|left&q=&before=&limit=`,
[roster-changes.ts](../src/data/roster-changes.ts) for the rules,
[roster-changes-repo.ts](../src/data/repositories/roster-changes-repo.ts) for
the rows). Nothing new is stored; it reads what the member sync already keeps:

- **Joined**: `game_players.joined_at` — the game's own join time (clan record
  `[2]` `joinedAt`) of the player's *current* stint, for every player ever seen
  in the clan (`in_clan` 1 or 0). The game overwrites it on a rejoin, so an
  earlier stint's join is never shown.
- **Came back**: a join after a recorded leave of the same member, or of a
  member the site already had on the roster more than an hour before the join
  (`members.first_seen` earlier) — they were in the clan before.
- **Restored**: audit `restore_member` (an admin's Restore), matched by name.
- **Left** (the game's): audit `member.left_clan` with `linked: true`.
- **Marked as left** (the site's record): `member.left_clan` with
  `linked: false` (the first sync sweeping an OCR-era row), or `members.left_at`
  with no audit row within a minute of it (the OCR-era 7-day sweep, the
  off-roster retirement, an admin's Remove). Dated when the site noticed.
- Never twice: `left_at` is the member's latest departure (cleared on the way
  back in), skipped when the sync's audit row is beside it. An unlinked row's
  sweep whose member has since been merged away or deleted is dropped (a
  duplicate spelling, not a person); a linked player's goes to the surviving
  member. `members.first_seen` is never shown as a join (it is when the site
  first read the name — for most of an OCR-era clan the day tracking started).
  `[Unknown]` never appears. Inactive members with no `left_at` (removed before
  the column existed) have no date and are left out.

The member Timeline's joined / came back / left entries come from the same
function, filtered to the member, so the two never disagree.

### Member Timeline: merges of screenshot-era spellings

The Timeline shows an admin's merge of another name into the member
(`merge_player` audit rows: 301 from 2026-04-07 to 2026-11-17). Most were the
OCR era's cleanup — the screenshot reader's misreadings ("lg 5 5S pw" for
"أوزيريس", "FENROTH Of CHAOS", "Mκam from Chaos") folded into the real name —
and read like events in the player's life when they aren't. A merged-in name
is a **screenshot-era spelling** when the game never reported it for any
player (`game_players.name`, `game_player_history.name`, any clan) and no
person typed it (the `newName` of a `rename_member` row without `source`):
before the switch-over names came from the reader or an admin, so a name that
is neither the game's nor an admin's can only be the reader's
(`isScreenshotSpelling`, [member-timeline.ts](../src/data/member-timeline.ts);
the repo looks the names up per request, exact strings).

Such merges are tagged (`ocr: true`, a muted "screenshot era" pill with an
explanation on hover), and a run of them — nothing else on the Timeline
between — folds into one entry dated by its newest merge: the era merged the
same misreading again and again (FENRØTH's variants 18 times from July to
August, "أوزيريس" 43 times). The fold lists each spelling once with every date
it was merged in (more than three: first – last · N×), headline "Merged 4
spellings into this member"; one spelling merged once stays a single line.
Nothing is hidden or deleted. Not tagged, shown as before: the game's own spelling merged into the
site's member (the six Cyrillic names on Nov 17, "Нимдуен" → "Nimduen", which
keep the readable name — see Members above), and names an admin typed (the
Nov 13 Seasonal Kingdom renames, "Tigger K260 SK" → "Tigger"). Manual
renames (`rename_member`) are never tagged.

Prod, Nov 17 2026: 249 of the 301 merges are tagged, 229 of them on current
members' timelines (85 members; 85–178 entries, as joins, leaves and might
moves split the runs). The 52 untagged: 42 merges
of Nov 13 (the admin-typed SK names), the six Cyrillic game names, "JOooO"
and "Princess Hulsa" (names the game reports), "Stortebeker" → "Störtebeker"
and "DR JMD" → "FRANK DA TANK" (typed). About 20 tagged ones look like real renames the
reader saw ("Grillkaiser" → "Child of Chaos", "Phoenix of chaos" →
"ChaoticChefPhoenix"): no stored name from before Nov 17 tells those from a
misreading, which is why the pill says "screenshot era", not "misread".

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
set when a login is saved through the bridge (its save checks the site page),
learned by the 30-minute session check or a scan only while unknown, and from
then on only CHECKED: a login that signs in as another account is flagged for a
new login, never adopted (see "Session check"). A clan whose account is not known yet runs
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
- **Sign-ins never overlap**, even across lanes: every call that presents a
  clan's site cookies (`GameClient.connect`, the session check) goes through
  `oneSiteCallAtATime` in client.ts, with a 3 s settle after each. Whenever
  SIK and SK7 signed in at the same moment, SK7's saved login came out signed
  in as SIK's account (Nov 17 2026, after the 14:37 and 16:18 cycles; never
  when SK7 ran alone). Only the sign-in is serial; claims and reads stay
  parallel. The session check also reports which site cookies two clans'
  saved logins share (by fingerprint, never value) — a shared session or
  device cookie makes two logins one browser identity to the site.
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

**A login that signs in as another account is never used.** Three checks, none of
which presents a token:

- `GameClient.connect({ expectSuid })`: the site page's account must be the
  clan's known one (`clan_scan_accounts`) before GetGameStartData; otherwise
  `WrongAccountError`, nothing sent to the game, the jar not saved, the clan
  flagged for a new login.
- The session check flags a changed account instead of adopting it, and warns
  (System page, resolves on a clean save) when the saved login carries a
  sign-in token (`__Host-user_auth_token`, a JWT whose payload names the
  account — `authTokenAccounts`, decoded locally) for another account than its
  session. That leftover is how SK7 flipped: a token for SIK's account from the
  clan's first login (Nov 13) sat next to the session of the account it was
  later re-saved with; once that session ended, the site signed in with the
  token.
- The login bridge's save checks which account it saved (audit
  `login_session_save` → `account`), sets it as the clan's account, and drops
  any sign-in token for another account from the file and from the bridge's
  browser profile (`droppedTokens`).

**A login that signs in to another clan is never scanned.** Right after the clan
record, [`runGameProtocolCapture`](../src/scheduler/game-protocol-phase.ts)
compares its game clan id with the one `game_clan_info` holds for the clan (a
clan's game id never changes). A mismatch throws `WrongClanLoginError` before
anything is written and flags the clan for a new login, naming both clans and
the account. Nov 17 2026: SK7's saved login signed in as SIK's scanner account
(15:18–15:31 UTC) and two scans wrote SIK's members, chats, research and event
standings into SK7 (cleaned by a one-time startup repair, 02aeb48: 188,802
rows; removed once it had run). The likely cause is the leftover sign-in token
above (a copy of SK7's login from Nov 16 23:00 held SIK's token while its
session was the SK7 player's account); nothing in the app writes one clan's
login into another's file.

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
any text endpoint, but it is in the build: PlayerSettings.bundleVersion in the
client data file's `globalgamemanagers` ("350.0.1122" in Nov 2026). Since Nov
26 2026 the login sends the live build's, read once per client patch
(`src/game-patch/client-version.ts`); `GAME_CLIENT_VERSION` overrides it and a
hand-set fallback covers "not read yet". See [game-patches.md](game-patches.md).

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
| 402 | `[[[id], [id], …]]` | player records: `[1]` suid, `[2]` name, `[4]` hero avatar (T13), `[5]` city look and `[6]` portrait frame (T52 customizations; v114), `[7]` hero level, `[8]` city level, `[9]` VIP, `[10]` might, `[11]` clan id, `[13]` clan tag, `[15]` `[realm,x,y]`, `[16]` city id, `[17]` Gold Ingots (public in the game; v110 keeps the current value on `game_players.gold_ingots` and the game day's latest in `game_player_daily` — they tick up every few minutes, so they are not part of `game_player_history`'s change check), `[19]` titles held `[[titleId, assignedAt]]` and `[20]` how often each was received `[[titleId, count]]` (v125, see Titles), `[22]` `[1]` = Gold Pass |
| 15031 | `[[[clanId], 0]]` | ledger `[entryId, [playerId], kind, resource, ts, [{res: amount}]]`, ~14 days. The client asks `[[[clanId], sinceTs]]` after a treasury send and got only the new entry (Nov 26 2026) |
| 15019 | `[[[[resourceId, amount]], [playerId]]]` | **sends from the clan treasury to one member** (Leader / Superior; one member per request — the game has no multi-send). Success is `[[]]`, and the next 15031 lists it as a kind-1 entry. Recorded Nov 26 2026 (31 Dragon Coins ×1). IRREVERSIBLE; only [dragon-coin-returns.md](dragon-coin-returns.md) sends it |
| 601 | `[[[[[cityId], 0, 2147483647], [[cityId2], 0, 2147483647], …]]]` (one or many) | city details (all records in `body[0][0]`): `[1][0]` owner, `[9]` captains (see above), `[12]` buildings, `[17]` `{techId: [techId, level]}` research and hero talents, `[26]` the player's dragon (not the hero), `[30]` own army. `[5]` is the inventory `{itemId: [itemId, amount]}` (item 2 = Silver) — filled only in the signed-in account's own city; every other player's reply has it empty, so other players' resources are not readable |
| 312 | `[[[tileIds], [versions], [], []]]` | per 20×20 tile `[tileId, version, …, [4] cities, [5] objects]`; `tile = floor(y/20)*50 + floor(x/20)` |
| 25 | `[[[clanId]]]` | clan might (key 1) and wealth points (key 7) — see "The clan itself" |
| 14003 | `[[[capitalId]]]` | the Clan Capital's Border counters; key 30 = help points |
| 28001 | `[[[clanId]]]` | the clan's displayed medals `[[medalId, earnedAt], …]` |
| 23 | `[[kind, count, [], false]]` | the kingdom's clan ranking `[[clanId, value], …]`, unsorted; kind 7 = wealth |
| 601 | `[[[[[cityId], 0, 2147483647]]]]` | city details: `[1][0]` owner, `[9]` captains (see above), `[10]` item instances, `[12]` buildings, `[14]` active effects (artifacts), `[17]` `{techId: [techId, level]}` research and hero talents, `[21]` titles held `{titleId: [titleId, eventId, assignedAt]}`, `[26]` the player's dragon (not the hero), `[30]` own army |
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
counts (2050 1h, 2051 3h, 2052 8h, 2053 15h, 2054 24h, 2055 72h). A member's event reward that pays Dragon Coins sends
them to the treasury as kind 4 under that member (CWB: 48 on Nov 4–5 2026, one
per member). What the CLAN wins (Dark Omens, Olympus, the Seasonal Kingdom) is
kind 5 or 8 under the Leader at the reset (Nov 6 18:00: 525,000 Dragon Coins +
27.5M Scientific Tractates + 700 clan fragments for CWB; Tools → Rewards fills its
pots from these, [rewards-tool.md](rewards-tool.md#the-pots-what-the-clan-won-from-the-ledger)). Kind 1 = a payout to a
member (15019 or by hand).

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

**24001 is asked on the RATING server, not the realm's.** The site page lists it
as `rating_url` (`https://game-us3.totalbattle.com/rubens-rating` for every realm
seen, SK7's included, plus a fallback; also realm 100000's `logic_url`). Same
frame, same session, same running request number as a realm request — only the
URL differs. A realm server simply never answers 24001: until Nov 17 2026 every
scan's event read failed "no 24001 reply" and nothing was ever stored. 38000 and
38003 do go to the realm server.

Titles come from T44 (`names.json` `events`, "type,run" → code, title key,
English title). A run maps onto the site's events by its English title against
the catalog's `calendarNames` / name, case- and accent-insensitive
([event-mapping.ts](../src/game-protocol/event-mapping.ts)): Rise of the Ancients
and Ancients' Treasure → ancients, TRIALS OF OLYMPUS and its five stages →
olympus, DARK OMENS → dark-omens, Ragnarök → ragnarok. Anything else (Trade
Routes, Summon Mastery, Prime Arena, …) is stored and shown under the game's
own title. One event is one code (`eventGroupKey`: the code, a code-less run by
its type); Olympus's overall ranking keeps the code `multistage` and each stage
is its own event by title (`multistage.trial-of-the-chimera`), since they share
it.

Shown: a "Standings from the game" card on the event's page (the run the
selected timeframe covers) for events without a scores card — Ancients,
Olympus, Ragnarok and Dark Omens show their per-summon / per-day table
instead ([tinman-scores.md](tinman-scores.md); pasting was removed Nov 25
2026) — and **Events → In-game rankings** (Nov 24 2026; one tile per event had grown to
~40 a clan after a week). Three addresses: `#events/in-game` is a Week/Day
window (the kit scrubber) — live now, the short rotating tournaments (runs
under 12 h, `isShortRun`: War Tools, Battle Training…) folded one row per
tournament, then each game day's runs; `?event=<key>` every run of one event;
`?run=<type>-<run>-<occurrence>` one run's standings. An event picker (every
event read, events then tournaments) is on all three; a run the game gives no
name stays out while nobody has points in it (`listableEventRuns`: type 1029,
nameless and three months long, sat under Live now as "Event 1029"). `GET /api/game/events`
answers a window (`from`/`to`) or one event (`event`) with each run's head count
and #1 (`summarizeEventRuns`), never its standings. On
**Events → Ancients** the Tin Man card itself is the game's per-summon table
(below).

### Rise of the Ancients per summon (v123)

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

### Trials of Olympus (v136)

Recorded Nov 24 2026 from CWB's Olympus window (research/tools/capture.mjs).
Olympus is an umbrella event, TRIALS OF OLYMPUS (type 1032, opens an hour
before day 1 and closes an hour after day 5), plus five stages, each a game
event with its own Clan members ranking (38003, from zero), one per game day:
Trial of the Chimera, Trial of the Basilisk, Lava Fountain Trial, Trial of
Tartaros, Trial of Briareus ([olympus.ts](../src/game-protocol/olympus.ts);
known by title, since the stage's type and run differ between variants: CWB's
were 1025/8, 1025/9, 1022/43, 1022/45, 1025/10). All share the code
`multistage`, as do "Pursuit of Lava Oil" (a catch-up) and "Sealed in Flame"
(PvP), which are not days.

**The umbrella's 38003 answers every member at 0** while the game showed
33,000. Its Ranking tab is read with other messages, every scan while it runs
([event-read.ts](../src/scheduler/event-read.ts),
[olympus-read.ts](../src/scheduler/olympus-read.ts)):

| Message | Server | Ask | Reply |
|---|---|---|---|
| 82003 | kingdom | `[[[1032, run]]]` | Clan members: `[rank, [playerId], points]`; stored as the umbrella's standings (+ history). The 82 rows summed to the clan's score, 393,845 |
| 82001 | kingdom | `[[[1032, run]]]` | `[[groupId], …]` — the matchup (590) |
| 82000 | `rating_proxy_url` | `[[[1032, run], groupId]]` | Clan ranking: `[rank, [clanId], points]` per clan of the matchup |
| 82002 | kingdom | `[[[1032, run]]]` | `[[minPoints, [[1, [rewardIds…]] per place]]]` — "the Clan must score a minimum of 600K"; only the minimum is read |
| 74003 | kingdom | `[[[1032, run]]]` | Clan Talents `[{6..10: level}, pointsLeft, …]` (stage 1..5) — archived (`olympus_talents`), not decoded: the "+50%" per level needs the talent table |
| 74001 | kingdom | `[[[1032, run]]]` | the signed-in account's own Personal Talents — not read |
| 77000 | kingdom | `[[[1032, run]]]` | the five stages `[type, run]` in order, the account's own goals done/total — not read |
| 192 | `reg_url` | `[[[clanId], …]]`, header `x-command-id: 192` | `[[kingdom, …]]` in the order asked — which kingdom a rival clan is in (CCH 213, GOF 157) |
| 15200 | the rival's kingdom | `[[[clanId]]]` | its headline (tag, name, members, might) — same session, as the client does |

Both new servers come from the site page (`rating_proxy_url`, `reg_url`). The
rivals' members' Olympus points aren't visible in the game and aren't asked
for (Sealed in Flame's Ranking tab, below, does list rival players).
Stored: `game_event_matchups` (group, reward minimum) and
`game_event_matchup_clans` (rank, score, kingdom, headline; a rival's
headline is read once per run). Shown on Events → Olympus
([tinman-scores.md](tinman-scores.md#olympus-from-the-game)).

Dark Omens (code `sabotage`) is clan-vs-clan too; expect the same shape with
other message numbers, and record its window when it next runs.

### Sealed in Flame: the Ranking tab (24003, Nov 25 2026)

Sealed in Flame (`multistage.pvp`, CWB's run 1015/81, Lava Fountain day) is
fought between the players of all three clans of the Olympus matchup. Its
Clan members tab (38003) answers all 81 members at 0. The game's Ranking tab
is the top 100 players of the matchup, any clan ("[K157] Vit
1,923,026,108"), asked on the **rating proxy**:

1. 24203 (kingdom server) `[[[[type, run], …]]]` → `[[type, run], [scope, group], [1, 1]]`
   per run. Sealed in Flame: `[6, 590]`, 590 being the matchup group (82001).
2. 24003 (rating proxy) `[[[[playerId], [clanId], realm], [[type, run], [scope, group], [0, 0]]]]`
   → body[0][0] = `[[[rows]], [[]], [[[kingdom, points], …]]]`, rows
   `[[playerId], points]` best first (94 when recorded: everyone who had
   scored), then body[0][1] the signed-in account's own line.

The scan reads both for a run titled Sealed in Flame (`isMatchupRankedRun`,
[olympus.ts](../src/game-protocol/olympus.ts)): the members stay the Clan
members tab's, each with their place and points in the Ranking tab; a member
outside it is stored with rank 0 = "no rank" (sorted last, never the leader,
"—" on the page). The 24003 reply is archived whole (`event_ranking`, rival
players included). Without a scope (24203 failed) the run isn't read at all:
its Clan members tab alone would only store zeros.

### What the rating proxy serves

Every message the two recordings (Nov 24 Olympus window, Nov 25 Sealed in
Flame) sent to `rating_proxy_url`, and the kingdom-server messages around them:

| Message | Server | Holds | Read by the scan |
|---|---|---|---|
| 24001 | rating proxy (and `rating_url`) | every event the realm knows (see Event standings) | yes, on `rating_url` |
| 24002 | rating proxy | `[[type, run], [scope, group]] → [points, rank, n]` per run for the **signed-in account only** (the client polls it ~every 30 s while a window is open) | no — our own account's line only |
| 24003 | rating proxy | an event's Ranking tab: top 100 players of its scope + top 100 kingdoms; worldwide except a matchup scope (below) | Sealed in Flame only |
| 24400 | rating proxy | `[[type, run]]` → `{kingdom: n}` for ~380 kingdoms — which bracket each kingdom is in for a cross-kingdom event (1001/1: mostly 6) | no |
| 82000 | rating proxy | Olympus' clan ranking | yes |
| 24203 | kingdom | each run's ranking `[scope, group]` (the client polls it) | for Sealed in Flame |
| 24201 | kingdom | `[[type, run], …, total]` per run for the signed-in account; the last field is its kingdom's total in the run's ranking (K260's 7,236,997,949) | no |
| 24500 | kingdom | `[[type, run]]` → reward tiers: tier, points needed, claimed, rewards (asked for Triumphal Challenge!, 1018/1: 7.9B, 18B, 33B…) | no |
| 82004 / 82005 | rival kingdom / kingdom | Olympus: the rival clans' ids, and each one's `[kingdom, x, y]` | no |
| 191 | `reg_url` | player ids → kingdom (the "[K157]" tags of a ranking) | no |

**The other scopes are worldwide** (recorded Nov 25 2026, the Ranking tab of
Lava Fountain Trial, War Tools, Pursuit of Experience `[1, 1]`, Pharaoh's
Bazaar `[4, 1]`, Triumphal Challenge! `[19, 1]`, Doomsday `[11, 36]`):

- the players are the top 100 of every kingdom (War Tools #1 5.2M, K260
  nowhere near) — **none of our 375 members in any of the six clans was in
  any of them**, against 37 in Sealed in Flame's;
- body[0][0][2] is the top 100 **kingdoms** with their totals (K260: #35 in
  Lava Fountain Trial, #17 in War Tools, #40 in Pharaoh's Bazaar, #59 in
  Triumphal Challenge!); Doomsday `[11, 36]` is a bracket of 62 kingdoms
  without K260;
- body[0][0][1] is empty except for Triumphal Challenge!, where it holds a
  second top 100 (ids not our clans' — likely clans);
- body[0][1], the own line, is `[ownRank, 0, kingdomRank]`: the signed-in
  player's place (0 outside the list; taulen #8 in Sealed in Flame) and their
  kingdom's place among the kingdoms (0 outside the top 100) — the same third
  value 24002 reports.

So for any event but a matchup-scoped one, 24003 holds nothing about our
members; only the kingdom's place. Not read. Rise of the Ancients (1024) and
Prime Arena `[8, 25]` weren't recorded.

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
| 4 | terrain types ("Dense forest") | f2 vector |
| 7 | map objects | f3 vector |
| 8 | gift types — and every item (`items`, format 10: f1 kind, f8/f12 seconds, f10 quality, f7 fixed resource grants; see [Chest rewards](#chest-rewards-its-own-menu-entry-chest-rewards)) | f3 chest name, f14 source template |
| 13 | hero avatars | f1 name, f3 icon |
| 9 | units | f1 name, f2 tier (0–10), f4 icon, f10 strength, f12 health |
| 21 | techs (research ~1000–1840, talents 25xxx/29xxx) | f1 name, f5 levels |
| 62 | clan medals | f5 vector (f4 unlock text, f6 tier) |
| 44 | events (tournaments), `$pairs` keyed `[[type, run], stage]` (asIdRecord joins it: "1024,1,1") | f10 config JSON → `info_title` ("global_tournament.client.value.clandoom_epic.info.title" = Rise of the Ancients) |
| 52 | customizations: f1 kind (1 portrait frame, 2 city look) | f2 name vector, f4 visual JSON |
| 75 | captains | `battler_unit.name.<key>` from f7's `animationLinkage` (`battler_<key>_unit`), else the f5 vector |
| 10 | heroes: the hero (row 1) and every captain (row = T75 id) | — f7 their 600 levels: XP thresholds, Stats, Might (see Captains above) |
| 73 | the Dragon (city field 26) | f2 its 300 levels `[level, xp, …, textRef]`, f3 its 8 evolutions, f4 the window config (see The Dragon above) |
| 11 | equipment, one row per item type AND quality grade | f3 vector |
| 110–113 | artifacts (`$pairs` tables keyed `[type]`) | T110 f8 vector |
| 29 | titles (402 field 19, city field 21; format 11) | f1 vector, f2 bonus text, f12 source, f7 seconds (see Titles above) |
| 1 | the client config, an array of `[keyRef, jsonRef]` rows (format 12) | the tech trees' and Academy tabs' name keys (`academy/branches`, `hero_info`, `clan`) — for the translations only |

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

Factions (T78) and the Hall of Fame: `names.factions` / `names.hallOfFame`,
every level's bonuses and requirement texts (NAMES_FORMAT 5) — see
[Hall of Fame](#hall-of-fame-techs-800803-profile--captains).

`names.json` carries a `format` (NAMES_FORMAT); a cached file with an older
one is rebuilt once.

**The names in the site's other languages** (NAMES_FORMAT 12,
[game-texts.ts](../src/game-protocol/game-texts.ts)): the same rebuild fetches
`csv_de_DE`, `csv_es_ES`, `csv_fr_FR` and `csv_ru_RU` from the translations
index (~0.6 MB zipped each), runs the build again per language — keeping only
the translation keys the English build read, ~4,000 of each CSV's ~25,000 —
and writes `texts-<lang>.json` (English → the game's own text, `{n}` patterns
for names with numbers) beside names.json, for tGame on the site
([i18n.md](i18n.md#game-names-tgame-the-games-own-text)). T1, the client
config, is decoded too, for the tech trees' and Academy tabs' names
([client-config.ts](../src/game-protocol/client-config.ts)). `names.textLanguages`
lists the languages written; a language whose CSV could not be fetched makes
the next load rebuild, at most every 6 hours, and its names stay English
meanwhile.

A rebuild downloads ~70 MB and decodes only the tables it needs (the rest are
skipped unbuilt), about 7 s. The decoded tables hold ~700 MB of heap at the
peak; the four language passes add under a second and ~150 MB of short-lived
heap (measured Nov 2026), inside the container's 1,536 MB.

The game's source text differed from what the OCR era stored in places ("Level
25–29 Vault of the Ancients" vs "Lvl 25-29 …"); v139 (Nov 25 2026) renamed the
stored rows to the game's names, and the scan writes the game's names verbatim.
