# Battle reports shared in chat

Members share battle reports in the game: the Tin Man, citadels, epics. The site opens every attack report linked in a chat the scanner account reads, keeps what it says, and shows the Tin Man hits under **Events → Ancients → Hits** with the Tin Man's stacks at each hit. Clan announcements shared the same way are kept as well (their text, for My Clan).

Recorded and decoded on Nov 27 2026 from a capture of the user opening reports in a test chat (`research/battle-reports/2026-11-27/`, machine-local).

## Where reports are read from

- **The clan chat** and **private messages to the scanner account**: always. A DM keeps citadel and Tin Man reports out of the clan chat.
- **Up to five group chats** an admin picks under Clans → In-game → Battle reports (`clan_report_chats`; the list of the account's group chats is folded — it can be long). The scanner account must be in the chat; the chat sync lists the account's group chats every minute (`refreshGroupChats`), so a chat it is added to shows up within a minute. A picked chat is read like the private chats: its history first, then new lines.

Nothing is ever posted. The scanner account doesn't answer a report in any chat (the chat-command rules: no reply to anything that isn't a command).

Shares are recorded where chat is saved (`saveChatMessages` → `recordReportShares`), so every channel the clan keeps counts. Only `attack` and `clan_announcement` links are kept; scout and crypt reports are not. The v143 migration queued every link already in stored chat (~2,500 across the clans).

## The journal service

[journal.ts](../src/game-protocol/journal.ts), [journal-token.ts](../src/game-protocol/journal-token.ts).

- **Token.** The game login reply (203) carries a JWT with `"aud": "Journal"` (index 16 of the reply root on Nov 27 2026; found by audience). It lives ~36 days, and its `name` is the player id. `GameClient.journalToken` keeps it; the chat session keeps it between scans (`chat-session.json`). It is already URL-encoded (`%3D` padding) and goes into the URL as is.
- **Socket.** `wss://journal-feed-kafka.totalbattle.com//?token=<JWT>`, origin `https://totalbattle.com`. Binary frames in the game's little-endian MessagePack ([codec.ts](../src/game-protocol/codec.ts)), with one difference: **`0xc7 <n>` is a wrapper around n ordinary values**, not a MessagePack ext (`c7 01 d9 24 "<uuid>"` is one string). `decodeJournalValues` / `WireReader(…, journal = true)` read it that way; game-server replies never do.
- **Request:** `[{2002062134: bin([method, seq], 0)}]`, then the argument array. Byte-identical to the client's (checked against the capture). **Reply:** `[{733765024: bin([seq, status, error])}]`, then the body. Status 0 = success.

| Method | Arguments | Answer |
|---|---|---|
| `1129936016` | `[journalV2EntryId]` | A shared entry: `[unix seconds, type, [bin]]`. Works for **any player's** shared report, across realms (a realm 289 session opened realm 1071's). |
| `2663587727` | `[entryId, [itemId]]` | Journal items by id: `{itemId: [bin]}`. A battle's strike log is one. |
| `1778507014` | `[category, cursor, 0, false, 10, null]` | Pages the account's own journal (not used). |
| `2485168634` | `[]` | Keep-alive, every 15 s (a short session needs none). |

**The game keeps a report about two months**: on Nov 27 2026 every report shared up to Sep 21 answered "Main content not found" (status 1) and every one from Sep 22 on opened. A report the game refuses twice is left as `unavailable`.

## What a report holds

[battle-report.ts](../src/game-protocol/battle-report.ts).

```
report  ["battle", won ("true"/"false"), rounds, ?, ?, ?, ?, attackers[], defenders[],
         strikeLogId (c7-wrapped), [], [], [], [], targetStaticId, rewards, [[],[],[]]]
side    [[realm, n], march (36 fields), [{}, killed {unit: n}, 1], …]
march   [[armyId], [[playerId], [cityId], …], …, units (index 30) [[unit, count, 0]…], …]
strike  [byAttacker, [armyId], unit, count, damage, extraA, extraB, 0, [targetArmyId],
         targetUnit, targetCount, targetPoolBefore, targetCountAfter, targetPoolAfter, 0, 0, 0, 0]
announcement  ["clan_announcement", [realm, n], text]
```

- **A side's player is its march's owner** (`march[1][0][0]`): the full id `members.game_player_id` holds (realm × 2³² + a number). The side's own `[realm, n]` — and a chat link's `guid` — keep only the number's **low 12 bits**: "taulen K260 SK" 4599909976661 = realm 1071, 0x258A55, shows as `[1071, 2645]`. Never key anything on them.
- **Units** are the army as it stood when the battle began; `killed` is what this battle cost. Unit ids are the game's troop/monster ids (T9).
- **Strike log**: every strike in order, with the exact health pools — the same model Tools → Citadel simulates (a stack's health is a pool; units alive = ⌈pool ÷ unit health⌉). `damage` is what the target took (capped at what it had); `extraA`/`extraB` are the log's two further figures (luck: a doubled strike shows `extraB` = half of `damage`).

## The Tin Man

- **"Epic Ancient squad" is the Tin Man**: 750 map objects (T7), three runs of 250 — 6000–6249, 7000–7249 (the Seasonal Kingdom's: SK7 on Nov 22 2026), 8000–8249 — one per level 1–250. Level = id − run start + 1 (6054 → 55).
- Its stacks are monster units 7540–7543. It starts with 4 and drops to 3, 2, 1 as its health goes; the report lists the ones it had when the hit began. **The clan rule is about these stacks, not the attacker's army**: some clans require hitting it at 4 — waiting for fewer gives one player more rewards at the clan's cost.
- **The rule is fixed: hit it while it has all 4 stacks** (`TINMAN_FULL_STACKS`; the user, Nov 27 2026: always on, no setting — the v143 `clans.tinman_required_stacks` column is unused). Events → Ancients → **Hits** ([ancients-hits.js](../src/web/public/pages/ancients-hits.js)) opens on the clan's members: one row each with hits at the rule, hits below it, the fewest stacks they hit at and their last hit, marked ✓ every hit at the rule / ✗ every hit below / ◐ both (glyph + words; below first), tiles counting each, the active members who shared no hit folded under it, and every single hit folded under that.

## Storage (v143)

- `battle_reports` — one row per report (the same report seen by two clans is one row): `status` pending → ok | failed (retried, backing off 5 min → 6 h, up to 6 tries) | unavailable; the parsed `summary` (JSON: both sides, the strikes; or `{announcement}`); `tinman_level`, `tinman_stacks`, `attacker_player_id`, `report_at` (the fight); and the **raw bytes** (`raw`, `strike_log`, gzip), so a better reading later re-parses without asking the game again.
- `battle_report_shares` — which clan saw it, in which chat, shared by whom (first share wins).
- `clan_report_chats` — the picked group chats.

A clan delete removes its shares and picked chats; the reports themselves belong to no clan.

## The calculators

Tools → Citadel ("Fill in from a battle report") and Tools → Stacks ("Fill in health from a battle report") open one dialog ([report-picker.js](../src/web/public/lib/report-picker.js)): a **player** select, then the battles. **Only the last 7 days** (`REPORT_WINDOW_DAYS`): bonuses change with captains and gear, so nobody fills in from an older battle — and searching every report's summary once per player made the dialog take seconds to open (Nov 28 2026; ~5,000 reports, 104 MB of summaries). It **opens on the viewer's own players** (`user_game_links`; their battles from every clan's chats) — several together as "Your accounts", each line saying whose army it is; a viewer with none picks a player first. Anyone who **fought or posted** a readable battle in the clan being viewed is listed to pick (their battles only as shared there). A player's battles are the ones they fought (the march owner — whose bonuses they are) and the ones they posted; each line says whose army it is and who shared it. The Citadel note then names the battle and the player.

**Tools → Citadel lists citadel battles only** (`?only=citadels`), and every citadel shows its **level** ("Elven Citadel · Level 10"). Both come from the game data: names format 16 keeps `citadels` — every T7 row named `atom.name.<kind>_stronghold`, with its kind and level (**T7 f15**: 1811 Elven 10 … 1817 Elven 30, 1814 Cursed 20; older versions such as 1798, also an Elven 10, keep their own ids). T7 kind 6 is NOT the test — it covers every army and garrison on the map.

**The numbers must be exact** — a citadel's counts sit on breakpoints, and a bonus off by a fraction costs troops. Values are kept at the game's own precision (3936.75, not the card's rounded 3936.8).

### Where a troop card comes from

The game draws a troop's card (opened from a report's "Show details") from the report alone — no request goes out (recorded twice, Nov 27 2026). The march carries **every effect active on it**: field 14, the city-record format `[effectId, sourceBits, count]` (research, captains, gear with its enchantments and gems, artifacts… — 697–720 effects for the user's marches), and field 16, the timed boosts with their start and end. A card's strength is the sum of every **kind 4** line (health: **kind 5**) of those effects whose unit-target list holds the troop's unit id (empty = every unit), of the general condition only — 45,239 of the game's 46,369 strength/health lines carry one condition set (2786 on Nov 27 2026; found by majority), the rest (71285 and a few) are situational and not on the card.

[troop-effects.ts](../src/game-protocol/troop-effects.ts) keeps those lines — effect → `[kind, target, percent]`, the 41 target lists shared — in **`troop-effects.json`** beside names.json, built by the same per-patch static rebuild (names format 15) and read only when a report army is built (`loadTroopEffects`, kept in memory). The raw bytes of every report read are kept, so the effects come from them (`parseBattleReport` → `effects`).

That sum is the card **less one army-wide amount the report doesn't carry** — the same for every troop of the march (guardsmen, specialists, monsters, siege alike): +100% strength / +115% health on Nov 7 2026, +115% / +115% on Nov 5 (the clan's research; it changes, so it is measured per report, never assumed). The page measures it from a troop the battle shows exactly ([report-bonuses.js](../src/web/public/lib/report-bonuses.js) `reportGaps`, the median over every such troop), then every troop's card = its effects' sum + that amount; a troop the battle shows exactly keeps what it shows. A battle that shows nothing takes the amount from the same army's nearest battle within 24 h (the notice names it).

### What a battle shows exactly

`GET /api/tools/report-armies?player=&only=` ([report-armies.ts](../src/data/report-armies.ts)) sends, per battle, its target (name, and a citadel's level), and per troop: units, the game's base stats (T9, art cache — `cachedArtUnits`), `card` (its effects' sum), its **health per unit** (the stack's pool on its first hit ÷ its units — exact) and **every strike** as logged (`damage`, `extraA`, `extraB`, killed or not).

- **Health** = health per unit ÷ base health − 1.
- **Strength from a strike logged in full**: damage = units × strength × M, M = 1 + bonus + "vs" features. **`extraA` is the share of the damage the features made** (damage × features ÷ M: Phoenix I on a Bear, 26 units or 1, the same 7.01 / 45.375), so bonus = M × (1 − extraA ÷ damage) − 1 — no feature table needed (it also holds against a player's own "vs mounted" research: Vulture VII and Royal Lion I hit Centaurs with +70% more feature than citadel-sim.js knows). M comes from `extraB` when the strike doubled (the damage before the luck), else from a strike the target survived. A strike that killed its target without doubling logged only what that took.
- **A siege engine on the walls**, killed or not: M = 20 × (1 + bonus + f) (f its "vs fortification" feature), so 1 + bonus = 20·f·s ÷ (1 − 20·s), s = 1 − extraA ÷ damage (Ballistae VII: 2277% Nov 7, 2229% Nov 5).
- A unit is the calculator's troop with the same game name and base stats (the troop icons' rule).

### Checked

`research/tools/cards-e2e.mts` runs the real path — the table built from the game's own files, the reports' raw bytes from prod, the page's code — on the user's three citadel reports: **all 20 troop cards, strength and health, equal the cards the user read in the game** (Nov 7 Elven 10 and Elven 30: Corax I 5226.5 / 3936.75, Royal Lion I 3736.5 / 2794.75, Battle Griffin VI and VII 5326.5 / 4036.75, Vulture VI and VII 3636.5 / 2694.75, Fire Phoenix I 3736.5 / 2794.75, Siege Ballistae VII 2277 / 1616.75; Nov 5: Corax I 4982.5 / 3687.25, Phoenix I and Royal Lion I 3658.5 / 2671.25, Ballistae 2229 / 1462.25) — including every troop whose strikes all killed their target. [report-bonuses.test.ts](../tests/web/report-bonuses.test.ts) pins the Elven 10 one; [troop-effects.test.ts](../tests/game-protocol/troop-effects.test.ts) the table.

## Vault chats

A picked group chat is read **for battle reports or for vaults** (v144, `clan_report_chats.purpose`; Clans → In-game: Off / Battle reports / Vaults per chat, five chats at most). A vault chat is where members link the Vault of the Ancients they raised — CWB's "-CWB VAULTS-" (76 members) and SIN CITY's "#SINSK7 VAULTS#" (98); both scanner accounts were already in them on Nov 27 2026. Every picked chat is read; battle reports linked in a vault chat still count.

A vault link is a shared map location: `coord` with `x`, `y`, `realmId` and `staticId` = the vault's T7 type, 150201–150499, **whose last two digits are its level** (true for all 237 vaults the map pass had seen) — **or the battle report of attacking it** (`journal` / attack on a vault type: RIDE and WarChild SK posted theirs that way on Nov 26 2026; with them SIN CITY's 86 posters match the chat's own count). A report, once read, gives the vault's tile (`targetAt`: the attacking march's target `[realm, x, y]`, march[1][14]); until then it matches only the poster's own vault of that level. [vault-posts.ts](../src/data/vault-posts.ts) reads the links posted in the run's window and matches each to a vault the map pass saw (`game_map_objects`, `listRaisedVaults` — a day either side of the window): same kingdom and tile, **same type**, and a time that fits (posted at most 12 h before the vault was first seen or after it was last seen) — one tile holds several vaults over a run (CWB's 790:162 held a level 39, the user's level 44 and another 39 within a day). The poster's own vault wins; else the one first seen nearest the post. A link counts for the member who posted it (`sender_player_id` → `members.game_player_id`); posters outside the roster aren't listed.

Events → Ancients → Vaults then shows a **Posted** column (✓ with the time / ✗ "Not posted"), a "Not posted" tile (members the map saw with a vault who linked none), and a row for a member who posted a vault the map never saw ("Not seen on the map", the level from the link) — raised out of the map pass's reach, or taken down before a scan. Without a vault chat the view is as before, with a note on where to pick one.

## Clan announcements

A clan announcement shared in chat is opened the same way (`["clan_announcement", [realm, n], text]`; the chat link's `name` is its author) and kept as `summary = {"v": 1, "announcement": text}`. My Clan → **Announcements** lists them newest first (`GET /api/game/clan/announcements`), each as a one-line headline with the day and author and the whole text folded under it; `/api/game/clan` carries the newest of the last 14 days as `latestAnnouncement`, the strip over My Clan's tabs.

The headline is rule-based ([announcement-headline.ts](../src/data/announcement-headline.ts)), from the leaders' own words with their capitals kept: lines that only greet ("HELLO CHAOS!", "Hey family,") and one- or two-word exclamations are skipped, a greeting running into the text is dropped ("Dear Chaos, we had…" → "We had…"), then the first sentence of a long line, cut near 100 characters. Tuned on the 23 announcements read by Nov 27 2026. No AI model is involved (the app has none; a real summary would need one and its key).

## The fetch

[battle-reports.ts](../src/scheduler/battle-reports.ts), called from the between-scans chat poll ([chat-capture.ts](../src/scheduler/chat-capture.ts)): every minute, per clan with a journal token, up to 20 waiting reports — that clan's own shares first, then **every other clan's** (any token opens any shared report; inactive clans have no scans and no token of their own: SINful Knights and Varangian Guard held ~3,500 waiting reports on Nov 27 2026), newest share first; the strike log of each battle too. Its failures never pause chat polling. An expired or refused token is dropped until the next scan's login.
