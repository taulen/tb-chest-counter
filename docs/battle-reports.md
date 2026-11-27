# Battle reports shared in chat

Members share battle reports in the game: the Tin Man, citadels, epics. The site opens every attack report linked in a chat the scanner account reads, keeps what it says, and shows the Tin Man hits under **Events → Ancients → Hits** with the Tin Man's stacks at each hit. Clan announcements shared the same way are kept as well (their text, for My Clan).

Recorded and decoded on Nov 27 2026 from a capture of the user opening reports in a test chat (`research/battle-reports/2026-11-27/`, machine-local).

## Where reports are read from

- **The clan chat** and **private messages to the scanner account**: always. A DM keeps citadel and Tin Man reports out of the clan chat.
- **Up to five group chats** an admin picks under Clans → In-game → Battle reports (`clan_report_chats`). The scanner account must be in the chat; the chat sync lists the account's group chats every minute (`refreshGroupChats`), so a chat it is added to shows up within a minute. A picked chat is read like the private chats: its history first, then new lines.

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

Reports from Nov 7 still opened on Nov 27: the game keeps them for weeks. A report the game refuses twice is left as `unavailable`.

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
- `clans.tinman_required_stacks` (4, 3, 2 or NULL) is the rule; the Hits view marks each hit ✓ / ✗ against it (glyph + words).

## Storage (v143)

- `battle_reports` — one row per report (the same report seen by two clans is one row): `status` pending → ok | failed (retried, backing off 5 min → 6 h, up to 6 tries) | unavailable; the parsed `summary` (JSON: both sides, the strikes; or `{announcement}`); `tinman_level`, `tinman_stacks`, `attacker_player_id`, `report_at` (the fight); and the **raw bytes** (`raw`, `strike_log`, gzip), so a better reading later re-parses without asking the game again.
- `battle_report_shares` — which clan saw it, in which chat, shared by whom (first share wins).
- `clan_report_chats` — the picked group chats.

A clan delete removes its shares and picked chats; the reports themselves belong to no clan.

## The calculators

Tools → Citadel ("Fill in from a battle report") and Tools → Stacks ("Fill in health from a battle report") open one dialog ([report-picker.js](../src/web/public/lib/report-picker.js)): a **player** select, then that player's battles. The players are the viewer's own (`user_game_links`; their battles from every clan's chats) and anyone who **fought or posted** a readable battle in the clan being viewed (their battles only as shared there). A player's battles are the ones they fought (the march owner — whose bonuses they are) and the ones they posted; each line says whose army it is and who shared it. The Citadel note then names the battle and the player. `GET /api/tools/report-armies?player=` ([report-armies.ts](../src/data/report-armies.ts)) sends the players and the picked one's newest 12 with a strike log: every troop's units and the game's base stats (T9, from the art cache — `cachedArtUnits`), its **health per unit** (the stack's pool on the first hit it took ÷ its units: exact, a full stack's pool is units × unit health) and the **base damage of each strike** it made. [report-bonuses.js](../src/web/public/lib/report-bonuses.js) works out the card bonuses in the browser, where the troops and defenders live:

- **Health** = health per unit ÷ base health − 1. "vs" features never touch health.
- **Strength**: base damage = units × strength × (1 + bonus + matching "vs" features), so bonus = base ÷ (units × strength) − 1 − features. The base is the log's `extraB` when the strike doubled (it IS the damage before the luck — the simulator's figure to the unit on all four such strikes of the Nov 7 report), else the damage when the target survived. A capped strike without `extraB` shows only a lower bound and is left out, as are hits on the walls (siege rules of their own). Features are known for the citadels' defenders (matched by name and stats); against anything else only a troop without features counts.
- A unit is the calculator's troop with the same game name and base stats (the troop icons' rule).

Checked on the Nov 7 2026 Elven 30 report (citadel opens): Corax I 5226.5% / 3936.8%, Fire Phoenix I 3736.5%, Vulture VI 3636.5%, Battle Griffin VI and VII 5326.5% — every value the user typed from the cards that day ([report-bonuses.test.ts](../tests/web/report-bonuses.test.ts)). Vulture VII, Royal Lion I and the Ballistae only made capped strikes or hit the walls, so that report leaves them alone; the pages' bonus families fill Royal Lion I from Fire Phoenix I.

## Clan announcements

A clan announcement shared in chat is opened the same way (`["clan_announcement", [realm, n], text]`; the chat link's `name` is its author) and kept as `summary = {"v": 1, "announcement": text}`. My Clan → **Announcements** lists them newest first (`GET /api/game/clan/announcements`), each as a one-line headline with the day and author and the whole text folded under it; `/api/game/clan` carries the newest of the last 14 days as `latestAnnouncement`, the strip over My Clan's tabs.

The headline is rule-based ([announcement-headline.ts](../src/data/announcement-headline.ts)), from the leaders' own words with their capitals kept: lines that only greet ("HELLO CHAOS!", "Hey family,") and one- or two-word exclamations are skipped, a greeting running into the text is dropped ("Dear Chaos, we had…" → "We had…"), then the first sentence of a long line, cut near 100 characters. Tuned on the 23 announcements read by Nov 27 2026. No AI model is involved (the app has none; a real summary would need one and its key).

## The fetch

[battle-reports.ts](../src/scheduler/battle-reports.ts), called from the between-scans chat poll ([chat-capture.ts](../src/scheduler/chat-capture.ts)): every minute, per clan with a journal token, up to 20 waiting reports — that clan's own shares first, then **every other clan's** (any token opens any shared report; inactive clans have no scans and no token of their own: SINful Knights and Varangian Guard held ~3,500 waiting reports on Nov 27 2026), newest share first; the strike log of each battle too. Its failures never pause chat polling. An expired or refused token is dropped until the next scan's login.
