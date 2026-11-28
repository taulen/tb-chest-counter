# Monster simulator (Tools → Monsters) and the game's battle data

> **Off the site since Nov 28 2026** (pages/tools.js): its count search lost far more than Tools → Citadel on the same citadels, so it is reworked offline first — benchmarked on citadels, where Citadel's answers are known, and across player levels (G3 to G9) — before it is shown again. The data, the engine and Citadel are unaffected.

Plays an attack on any monster target out strike by strike, for both coin flips: every Common, Rare, Heroic, Legendary and Epic squad level, the event bosses, the Tin Man, raids and vaults. Built on the same engine as Tools → Citadel ([citadel-simulator.md](citadel-simulator.md)), with every number taken from the game's own files instead of typed in.

## The data: battle-data.json

[battle-data.ts](../src/game-protocol/battle-data.ts), built by the names build once per game patch beside names.json (`NAMES_FORMAT` 17, [static-data.ts](../src/game-protocol/static-data.ts) `makeBattleData`), loaded by [data/battle-data.ts](../src/data/battle-data.ts) and served at `GET /api/tools/battle-data` (ETag = the static-data version, `private, max-age=600`, gzipped; 370 KB, 57 KB gzipped on Nov 28 2026). A patch whose armies can't be read keeps the previous patch's file and logs a warning.

- **Units** (T9): name, tier, strength, health, tags, "vs" features with their damage multiplier, icon. A unit a player can send also carries its kind and march cost: `kind` from the cost (authority → mercenaries, dominance → monsters, leadership → guardsmen / specialists / siege by tag). Field meanings: [game-protocol.md](game-protocol.md) (T9 Units). Nov 28 2026: 35 guardsmen, 36 specialists, 30 monsters, 10 siege engines, 140 mercenaries (113 names; Bull Rider, Sphynx and others are two or three different units), and 599 units of the map's armies. The game's 75xxx copies of trained troops and mercenaries (same numbers, no march cost) are left out; armies carry the lower id.
- **Targets** (T7 type 6 with an army): name, level (f15), class (f18), who may lead (f10, f11), army `[[unitId, count]]`, strongest stack first, walls included. Only a family's **live class**: class 0 never (older versions — a "Common Elf squad" level 39 of legacy Inferno units, Cerberus and Overseer under ids 1017/1018, showed up on the page and one Warregal beat it; the old Legendary and Epic Elf/Barbarian/Cursed squads; no shared report ever hit one), a citadel family's citadels (class 4; its class-2 objects are the old citadels, 0 of 29 hits), any other family's main class. Identical armies under several ids are one target listing every id. Objects whose name key has no text in the game's files (tutorial and test objects) are left out, and so are Exiles' Grove (type 22) and player cities.
- **Revival gold** (T9 f6, `{"1": gold}`; item 1 is Gold, 2 Silver — f7 is the silver to heal one when defending, 10×): `revive`, the gold to revive one unit lost attacking. It equals Kaiculator's revival gold for all 53 mercenaries it lists (Corax I 80, Fire Phoenix I 864, Wyvern 500, Superior Epic Monster Hunter 8).
- **Names in every language**: names.json `units` holds the same units' names, so the texts build pairs them with the game's own text ([i18n.md](i18n.md)); map objects' names were already there.

## Who leads: the Hero or captains

Each target says who may lead an attack on it (the user, Nov 28 2026: only the Hero can attack a Rare squad), and the game's data has it: **T7 f10 = whether the Hero may lead, f11 = how many captains may join** (battle-data `hero`, `captains`, format 2). A report says who led: **march field 9** lists the commanders, `[[commanderId, …]…]`, where 1 is the Hero (the game's hero table keeps the Hero as row 1, each captain under its T75 id) — `BattleSide.commanders`, report-armies' `led`. Every one of ~1,500 shared reports keeps to its target's rule (Nov 28 2026, `research/monster-sim/commanders.mts`):

| f10 / f11 | Who leads | Targets |
|---|---|---|
| 1 / 0 | the Hero alone | Rare squads, Basilisk, Forest Hermit, one Epic Inferno version |
| 0 / 1 | one captain | Common squads, Epic Fenrir, the Tin Man, Baron Candlemourn, Epic Famine and Greed, raids, vaults |
| 1 / 3 | the Hero with up to 3 captains (the Hero may stay home) | Heroic squads, citadels, Epic Death, Ashen, Jack Reaper, Shadow City, Vineweaver |
| 0 / 3 | up to 3 captains | Briareus, Arachne's Swarm, Arcanomancer |

It matters because the bonuses (the Hero's talents and gear, or the captains' skills) and the march's leadership differ with the leader: a Hero-led Rare squad march is not a captain-led Common one. The page shows the rule under the target ("Attack: Led by the Hero alone"), and **Suggest** and **Fill in** warn when the battle they read was led differently (`battleCommand` vs `targetCommand`). Armageddon is an event (T44), not a map object; which of its epics are the Hero's is whatever f10 / f11 say per target.

## The engine

[battle-sim.js](../src/web/public/lib/battle-sim.js), shared with Citadel (whose rules, evidence and luck are in [citadel-simulator.md](citadel-simulator.md#how-the-rules-were-obtained)). A unit def is `{ id, str, hp, tags, vs }`; `vs` is either Citadel's `{ tag: percent }` or the game's `[[tags], percent, multiplier]`. Walls are any unit tagged `fortification` or `citywalls`; a siege engine is Citadel's flag or the game's `siege` tag.

`optimizeArmy` is Citadel's count search, generalised: any army, any enemy, rows marked `protected` (monsters, mercenaries) never traded for cheaper losses, and an optional `cap` per row (what the player has) that no count goes over.

## How it was checked (Nov 28 2026)

Every shared report in prod with a strike log (~840 monster battles plus 659 Tin Man hits) was replayed against the game data, with the player's bonuses measured from each report (strikes and health pools, else the march's effects plus the army-wide gap: [battle-reports.md](battle-reports.md#the-calculators)). Scripts and output: `research/monster-sim/` (machine-local).

- **Monsters fight at their base numbers.** Every monster health pool and every monster strike matched T9 with a 0% bonus; an army is exactly T7's when nobody hit it before (epics and bosses are usually already hit: the report shows what is left).
- **The rules hold**, strike by strike with the log's state (374,502 strikes): who strikes next 100% (players' and monsters' stacks), the target 99.6% (players) / 99.5% (monsters), the damage 100% / 99.8%. Group attacks (2–5 players' armies on one side) play by the same rules. Misses are ties to the last point and players' stacks the battle never hit (their health is an estimate).
- **Whole battles** played by the engine from the opening state, luck from the log: 284 of 1,376 replay to the last strike. The rest part ways at an exact tie (the game's coin flip, see Citadel's turn order) or at a player's bonus the report can only estimate; the monsters' side parts first in only 37. [battle-sim.test.ts](../tests/web/battle-sim.test.ts) pins 12 of them (a Common, a Rare and an Epic squad, Briareus, Basilisk, Arachne's Swarm, Vineweaver, Epic Fenrir, Baron Candlemourn, two Tin Man hits) from [monster-battles.json](../tests/fixtures/monster-battles.json).
- **Blocks**: 45 monster strikes (about 1%) dealt 67%, all on monster- or beast-type troops (Citadel's Luck).
- **Event bonuses**: against an event's own monsters a player's army can have an extra "vs" bonus the static features don't carry: +450 / +550% on Epic Fenrir squads (97% of strikes), on Baron Candlemourn and Jack Reaper (+45 to +500%). It is one number per army (94% of armies) and appears on no other target — ordinary epics, Briareus, Chimera, Common/Rare/Heroic squads show none. A report against the same target shows it exactly. The Fenrir replay only matches with it.
- **Not modelled**: Grove Elder and the other Corruption monsters take 10% less damage (tags `corrupted` / `uncorrupted`); some event units carry `lifesteal`, `magicdef` or `feardef`. Exiles' Grove's defenders hit with "vs" features above the static ones and have walls; it is left out.
- **Scouts fight**: Grace struck 4,652 times in these reports, Spies, Swift Jaegers and Panoptic too.

## The page

[monster-tool.js](../src/web/public/pages/monster-tool.js); the data side is [monster-army.js](../src/web/public/lib/monster-army.js), the result cards and strike list [battle-result.js](../src/web/public/lib/battle-result.js) (Citadel's look; Citadel itself still draws its own).

1. **The target**: Type, then Target, then Level — every target but citadels (they are Tools → Citadel's; the card links there), grouped Common / Rare / Heroic / Epic squads and bosses / Raids / Vaults / Other (`targetGroup`: the T7 class, the name where the class is 0), then its level, then — where the game keeps more than one army at that level — the version, each listed with its army. "Inside" shows the army with the game's icons (`unitIconHtml`: any unit by its T9 icon and tier frame). Your levels are Citadel's (`/api/tools/citadel-levels`), and gate the picker the same way.
2. **Your army**: rows of troop, count, strength %, health % (health only where the result asks for it, as in Citadel). The picker offers every unit the game lets a player send (`fieldableUnits`), grouped by kind; a mercenary sharing its name with another shows its tier. Where the target has event monsters (tag `epicmonster`), one field holds the army's extra strength against them.
   - **Suggest an army from my latest battle** (the chosen linked player, `GET /api/tools/report-armies?player=`, the battles they fought in the last 7 days): **the latest battle led the way the target is** (the user's rules, Nov 28 2026: troops of a week ago, or yesterday, may be gone, and a Hero-led march's bonuses and leadership are not a captain-led one's — so a player shares one report of each before planning: a Rare squad uses the latest Hero-led battle, a Common squad the latest captain-led one, a Heroic squad or citadel the latest Hero-with-captains one, else a Hero-led one). With no battle led that way it takes the latest battle and says so: the box turns amber ("led differently from this attack") and a notice asks for a report of an attack led that way. Every troop of it, its bonuses (report-bonuses.js through `reportTroops`: exact where that battle shows them, else the march's card plus the army-wide part — the player's other battles led the same way, within a day, only fill those gaps), and `cap` — how many it had (purchases of one mercenary summed). Counts come from the search, never above the cap; rows it leaves at 0 say "none needed" and one button removes them. No averaging: one battle, one set of numbers. A box above the rows says it plainly — "Army from your latest Hero-led battle" (captain-led, Hero with captains), the battle (day, target, player) and its age, amber with ⚠ past 6 hours ("troops trained or lost since then are not in it"); each row says "{n} in your latest battle". The event bonus comes from that battle when it fought the same target. Captains and the Hero are never chosen by the page: the report's bonuses are the ones the player marched with (the user's call).
   - **Fill in from a battle report**: any battle of the last week (Citadel's dialog, every target). With no rows yet it takes the battle's whole army and its target, in Manual, so the battle can be replayed; otherwise it fills the rows' bonuses.
   - **Counts**: Auto (the explore search, `optimizeArmy({ explore: true })`, 3% safety; a fixed amount of work in a Web Worker with a progress bar — about 0.8 s on a desktop (p95 1.4 s), 3–5× that on a phone, the same army on both: [the count search, reworked](#the-count-search-reworked-nov-28-2026)) or Manual. **Mercenaries and monsters are never traded for cheaper losses, judged on the worst coin flip of all four battles** (`worstCase`, `protWeaker`: the 3%-weaker battles are a margin): "a few cheap troops if I strike first, ~400 mercenaries if they do" was an answer before (the user, Nov 28 2026), and against anything but an epic losing mercenaries is never worth it. The other losses count **at the bonuses as typed** — what the page shows; the weaker battles must only be won (`scoreWeaker: false`) — weighed by what they cost: a normal troop the **Silver to train** a new one, less the player's training discount for its kind; a monster or mercenary its **revival Gold** ([learned starts](#learned-starts-round-2-nov-28-2026)). Learned starts from other armies' best answers for the same target are tried too. The search also starts from the army without any mercenary or monster, so they join only where the rest can't win. On the user's own army: Tin Man 10 went from 287 Gallopers lost to none (cheap guardsmen take it), Rare Barbarian 25 from 3,169–4,915 troops and a Quicksand to 47–112 Battle Griffin VI.
   - **Player**: an account linked to several players (alts with different armies) picks which one Suggest reads (`?player=`; a player the scans haven't named yet shows its link's name).
3. **Result**: both coin flips, losses per troop, and for a lost fight how much of the enemy army fell ("wiped out after killing 18,593 of 1,498,053,550"); the strike list shows the first 600 strikes and says how many more there were. An epic that can't be beaten in one attack says so in Auto and offers Manual.

The draft stays in this browser (`tbcc.monsters.draft.v1`); there are no saved armies yet.

## The count search, reworked (Nov 28 2026)

Auto in Tools → Monsters and Tools → Citadel is now the **explore search**: `optimizeArmy({ explore: true })` / the generator `optimizeArmySteps` in [battle-sim.js](../src/web/public/lib/battle-sim.js). It replaces the one-start local search, whose answers lost far more than the best armies known. Monsters' objective was then: win both coin flips and with every bonus 3% lower, then the fewest protected (mercenary + monster) losses on the worse flip, then the fewest other losses by revival gold (both averaged over the battles at 100% and 3% lower), then the smaller army — the user changed it later that day ([learned starts](#learned-starts-round-2-nov-28-2026)). Citadel's is below.

**How it was measured.** A benchmark (`research/monster-sim/bench/`, machine-local): 711 scenarios — the latest real army of 32 players from shared reports (one per player and command, bonuses as each report shows them, cap = what that battle sent; 3–70 troop rows) and one made-up army per level G3–G9 (top two tiers of every kind, a siege engine, the mercenaries that level sends most, the median bonuses and counts players of that level have: about 110–230% strength at G3, 700% at G5, 2,100% at G7, 3,750% at G9) — each against Common, Rare and Heroic squads, vaults, raids and the 7 live citadels: per family the highest level the whole army beats in both flips with 3% less ("near-limit") and one at 2/3 of it ("easier"); no epics. The yardstick is the best answer any run ever found: a 60 s iterated local search per scenario, the new pipeline at 10× its budget with two seeds (~7 s each), and every experiment on the way (about 40 configurations, hundreds of millions of battles).

**What the simulations taught** (each kept only where it moved the benchmark):
- The old search stalls where it starts: its descent from all troops or the one-shot start ends in very different places from other starts. Stages: (1) **greedy** — build an army from nothing: a siege engine for the walls, then, again and again, the one row and count that leaves the enemy weakest (every move scored on the hardest battle only, the best three in full); (2) **page** — the old descent from the old start, so an answer is never worse than the old one from the same starts (it plays at least the old search's 2,500 candidates); (3) **roles** — roleStarts, game01master's sizing made general; (4) **grow** — add one more killer or resize one row, a short descent, keep it if it beats the best, until it stops helping; (5) **kicks** — a row out, halved or doubled, a protected row out with every other row at all it has, or one row swapped for another.
- **More killers.** The rows the best answers had and ours lacked were mostly protected monsters and mercenaries that strike first and are never hit, at counts that tie another row in turn order, kill a stack whole, or one or two units (a single high-health monster unit both kills a stack and takes a hit without dying). "grow" proposes exactly those; it found the improvement in ~60% of scenarios and gets most of the work.
- **Moves.** Six kept moves in ten were ±1 or ±2 (15% of such tries kept, against 0.2% for adding a row at an arbitrary count): a small step that helps is now followed, twice as far each time, instead of one step per pass. A row not sent tries only one unit or a whole-stack kill.
- **Cheaper candidates.** The four battles of a candidate run hardest-first (weaker army, enemy opening) and stop as soon as it can't beat the best so far — mid-battle too (`simulateArmies` `onLoss`, a stop that changes no rule); scores are kept by counts. The engine itself is ~2× faster with identical battles (no per-strike allocations, features looked up per pair of unit types, tie keys worked out only for ties; 8,000 random battles compared field by field against the old code).
- **A budget of work, not time** (`EXPLORE_WORK`, 6·10⁷ of (strikes + 50) × stacks): deterministic — a phone finds the same army, only slower. Plain Node, one core: p50 0.73 s, p95 1.24 s, max 1.6 s on 60 random scenarios (the old search: p50 0.22 s, but 2.5 s — its time limit — on the big ones).

**Results** (all 711; "×" is the other losses against the best known where protected losses are equal, geometric mean):

| | old search | explore |
|---|---|---|
| equal to the best known | 30 | 122 |
| more protected losses than the best known | 175 | 164 |
| other losses, easier targets (239) | ×1.41 | ×1.15 |
| other losses, near-limit (273) | ×1.16 | ×1.08 |
| other losses, citadels (199, real armies) | ×2.72 | ×1.25 |

Protected losses: on easier targets and citadels both lose none wherever the best known loses none (238 of 239, 189 of 191). Near the limit, where some loss is unavoidable, the explore search loses more than the best known in 153 of 273 (median ×1.11 in gold, +12 units on the worse flip; the old search 164, ×1.23).

**Citadel.** `optimizeCounts` uses the explore search too, with its game01master starts and two rules of the user's (Nov 28 2026): the score is the losses **at the bonuses as typed** — what the page shows, the mean of both flips, monsters and mercenaries first, then the rest by base health, then the smaller army; the 3%-weaker battles must still be won in both flips but their losses don't count (`scoreWeaker: false`) — and the old search's answer for the same army is the floor (`baseline`: it runs too, at the end, and wins if it scores better). Judged that way against the old Auto: 56 benchmark armies × citadels (the user's cards, game01master + cleanups, the recommended setups, G5–G7 armies) better 28, equal 28, worse 0 (on the worse flip: the same); 700 random armies (3–8 troops, one bonus level, always a siege engine) better 431, equal 269, worse 0 (on the worse flip: 420 / 273 / 7). Units lost (rather than base health) went up in 8 of the 56 and 115 of the 700, where the answer loses fewer monsters, mercenaries or high-health troops and more cheap ones. The user's cards: Elven 25 365/116/4/30/31/1162 loses 15 / 31 Corax I as before, Elven 30 1853/583/25/160/204/5926 80 / 154 as before, both with smaller armies; Cursed 25 13 / 13 → 5 / 5. About 0.75 s in Node (p95 0.86 s, the old search included).

**Off the main thread.** Both pages run the search in a module Web Worker ([battle-worker.js](../src/web/public/lib/battle-worker.js), started by [army-search.js](../src/web/public/lib/army-search.js) from its own URL, so it keeps the page's `/v/<build>/` prefix), or where workers can't start, on the main thread in 30 ms slices. A newer search cancels the older (the worker is replaced). The search reports `{ done, total, phase }` every 0.5% of its work; [search-progress.js](../src/web/public/lib/search-progress.js) shows a bar and "Trying starting armies… 40%" / "Improving the best army… 75%" (a `progressbar` for screen readers, outside the results' live region).

**Not good enough yet.**
- Without game01master's start the explore search still doesn't find Citadel's own Elven 25/30 answers for the user's cards: 20/36 and 102/177 Corax I lost (Monsters' settings), against Citadel's 15/31 and 80/154 (the old Monsters search: 21/37 and 104/179). A generalised "cleanups sized just below the last killer" start did not get there. Citadel keeps game01master's starts and the old answer as its floor, so its own answers don't depend on this. (Round 2's learned starts get there: 15 / 30 and 79 / 154 — [below](#learned-starts-round-2-nov-28-2026).)
- Against the best known it is ×1.17 on other losses overall (×1.09 with 10× the work, ~7 s: much of the gap is budget) and loses more protected units in 164 of 711, nearly all near the army's limit.
- Phones: 3–5× slower than the desktop numbers above, so about 2–4 s typical and up to ~8 s for the largest suggested armies, with the bar showing it.

## Learned starts (round 2, Nov 28 2026)

Round 1 showed that the gap to the best known answers is mostly where the search starts and how much work it gets: given game01master's starting counts, the same search finds Citadel's answers exactly. Round 2 learns starting points offline for every live target and ships them as one small data file.

**The objective, as the user set it on Nov 28 2026** (both tools):
- Losses count only in the battles at the bonuses as typed — what the page shows. The 3%-weaker battles must still be won in both flips (`scoreWeaker: false`). Tools → Monsters judges mercenaries and monsters on the worst of all four battles (`protWeaker`: the weaker ones are a margin); Tools → Citadel on the mean of the two flips at 100%.
- What a loss costs: a normal troop (guardsmen, specialists, siege) the **Silver to train** a new one — "we never revive troops we can build ourselves with just silver" (T12, battle-data `train`, format 4) — less the player's training discount for its kind (`discounts`; they differ per kind, so they change which loss is cheaper: for one of the user's accounts a siege engine costs 2.2× more against a guardsman than at list price). A troop the game doesn't sell (Royal Paladin, the event troops #5000–5005) costs its Silver revival price, 10× its gold. A monster or mercenary costs its **revival Gold**. The two are never added: monsters and mercenaries rank first. Revival discounts scale every troop alike and are left out. `lossPrice` in citadel-sim.js and monster-tool.js.

**Data.** 526 armies: the 228 latest real armies from the shared reports (one per player and command; bonuses as each report shows them; caps = what that battle sent), a variation of each (bonuses ×0.85–1.15, caps ×0.4–2.5, up to 40% of rows dropped), and 70 made-up armies for G3–G9. The split is by player: 75 real armies, their variations and 21 made-up ones are held out (test); the rest train. 41,785 Monsters scenarios: every live non-epic family (Common, Rare, Heroic, vaults, raids), two levels per army and family among those it beats (often its highest), 1,201 targets. Tools → Citadel: 381 armies of Citadel's own troops (game01master-style sets with every swap, and random 3–8 troop armies) × the 7 citadels; the user's exact cards are test only. Best known answers: the explore search at 2.5× the page's work, seeded with earlier answers (Citadel: with game01master's starts too), on 26–30 cores for about three hours (Monsters: half of the scenarios, 20,893). The files are under `research/monster-sim/bench/r2/out/` and the runs resume.

**What a start is** ([army-starts.js](../src/web/public/lib/army-starts.js)). Raw counts don't carry over — bonuses, caps and troops differ — so each row of a best answer is kept as what it does in that battle:
- `k`: the share of one enemy stack's health its first strike takes (a killer: count = share × the stack's health ÷ one unit's hit at this army's bonus). A killer with units to spare keeps those apart as hits of that stack it can take, sized by health — game01master's first striker, which also absorbs the dragon's opening strike, only carried over once this was split out (Elven 30: 82/156 before, 79/154 after).
- `h`: a row that never strikes but is hit — how many of that stack's strikes it can take.
- `n`: one to three units, kept as a count (a sponge, a single monster).

The same army gets its own answer back exactly (260 of 260). For a new army, the target's answers are ranked by how much of them it can play (its own troops; a missing troop is stood in for by one of the same kind and way of fighting), different shapes first (which troop lines are sized for which enemy stacks), then armies of its tier and bonus level; the top three become extra starts. A target without answers borrows its family's nearest level (shares carry across levels). game01master's own answers — its recommended troop sets at the bonuses of its own table, Elven 25 and 30, 36 templates — sit in the library as data beside the best answers: a second shape a citadel army can start from.

**Results on held-out armies**, against the best known (the best of every run) and the search as shipped in round 1, the page's work (6·10⁷):

Tools → Monsters, 6,859 held-out scenarios (the test half that the heavy pass solved; every mode wins all of them in both flips and with 3% less). Mercenary/monster gold is on the worst of the four battles, which the search ranks first:

| | equal to the best known | more mercenary/monster gold than the best | other losses vs best (Silver, geo) | mercenary/monster gold (mean) |
|---|---|---|---|---|
| best known | — | — | ×1 | 16,010 |
| round 1's search | 3,106 | 674 | ×1.151 | 17,106 |
| + learned starts (as shipped) | 3,165 | 665 | ×1.115 | 17,058 |

- By group, other losses (round 1 → learned starts): raids ×1.451 → ×1.167; heroic ×1.547 → ×1.499; common ×1.072 → ×1.043; rare ×1.089 → ×1.082; vaults ×1.118, unchanged.
- By tier: G3–G6 hardly move (×1.01–1.05, little to gain). G7 ×1.177 → ×1.121, G8 ×1.181 → ×1.132, G9 ×1.206 → ×1.163.
- The 3,038 real armies alone: ×1.196 → ×1.137 (raids ×1.696 → ×1.193). Mercenary gold 19,464 → 19,397; the best known is 17,945.

Learned starts cut the Silver; they barely move the mercenary gold. That gap is the search's work, not its starts (the parallel lever, below).

Tools → Citadel, 875 held-out scenarios (Citadel's own score):

| | equal to the best known | silver vs best (geo) | troops lost, both flips (mean) |
|---|---|---|---|
| round 1 (game01master's starts) | 678 | ×1.019 | 3,588 |
| + learned starts (as shipped) | 712 | ×1.018 | 3,367 |
| learned starts, no game01master | 710 | ×1.021 | 3,369 |
| neither | 671 | ×1.023 | 3,518 |

The user's cards (held out, never learned from), **without game01master's starts**: Elven 25 365/121/4/27/42/1206 loses 15 / 30 Corax I (Citadel with game01master: 15 / 31), Elven 30 1889/579/25/160/207/5993 loses 79 / 154 (80 / 154); the search alone, without learned starts, 20 / 36 and 101 / 175. Against Tools → Citadel's Auto as it was before Nov 28 (health weights, the 3%-weaker battles averaged in), judged on the losses shown at 100% in silver and gold: 56 benchmark armies × citadels better 29, equal 27, worse 0; 700 random armies better 485, equal 215, worse 0 (on the worse flip alone 4 worse: the score is the mean of both flips). The number of troops lost went up in 6 of the 56 and 73 of the 700, where cheaper troops die instead of dearer ones.

**The parallel lever.** These runs used every 4th held-out scenario (1,715).
- "Side by side" means N searches at once, seeds 1…N (`searchArmy`'s `jobs`), keeping the best answer.
- Timings are desktop wall clock in Node over 60 scenarios, a worker's start included. A phone is 3–5× slower, and its small cores do worse with searches side by side.
- The best known answers include every one of these runs. That flatters the 4× row's ratio; the gold column is absolute.

| | other losses vs best | more mercenary gold than the best | mercenary/monster gold (mean) | time p50 / p95 |
|---|---|---|---|---|
| round 1's search | ×1.190 | 184 | 16,048 | — |
| 1 search, learned starts (as shipped) | ×1.148 | 184 | 16,048 | 0.81 / 1.41 s |
| 2 side by side | ×1.118 | 170 | 15,754 | 0.87 / 1.44 s |
| 4 side by side | ×1.099 | 146 | 15,513 | 1.00 / 1.60 s |
| 1 search, 2× the work | ×1.080 | 154 | 15,486 | 1.65 / 2.72 s |
| 1 search, 4× the work | ×1.013 | 57 | 15,200 | 3.23 / 5.38 s |

The best known is 14,975 gold.

Seeds change only the random stages after the same starts, so their answers come out alike. Four searches side by side spend four cores to get what one search with 2× the work gets on one core. The work itself is what closes the mercenary gap: at 4×, heroic other losses go from ×1.95 to ×1.02 and the mercenary gold falls 5%.

The pages keep one search at the page's work (`jobs` 1, `EXPLORE_WORK`). Giving Tools → Monsters more is one number, `work` in its search params. The cost is the wait: 2× ≈ 3–8 s on a phone, 4× ≈ 10–25 s. That is the user's call; it was not changed.

Two more ideas were tried and dropped:
- **Six answers per target instead of two:** ×1.103 and 17,021 gold on the whole test, against ×1.107 and 17,058. That is within one seed's spread (seed 2 of the same: ×1.097, 16,984), for 3× the file.
- **A kick that cuts every protected row at once** (½, ¼, the rest refilled): 4 better / 1 worse on the 647 scenarios where mercenaries were lost above the best, 1 / 5 on 647 others.

**The file.** `src/web/public/data/army-starts.json` (format 2: `{ v, targets: { <T7 id>: { e: enemy units by stack, x: [{ t: tier, b: bonus level, r: roles }] } }, families: { <name>: [[level, T7 id]] }, citadels: { <citadel id>: { e, x } } }`; a role is `[unit, "k3", share, hits?]` — mode and enemy stack in one string, four significant digits, `decodeArmyStarts` reads it back; a file of another format is not used), 812 KB on disk and 186 KB gzipped — Cloudflare compresses JSON on the way out, the origin doesn't. It holds two answers per target (1,176 targets: the two best of different shapes) and 1,525 citadel answers, 36 of them game01master's templates; built from train and test answers alike once the evaluation was done, never from the user's own cards. Keeping six answers per target instead of two is 548 KB gzipped for no measurable gain (below). Both pages load it once from a URL built from army-starts.js's own (so it carries the page's `/v/<build>/` prefix, docs/cloudflare-caching.md) and only add its starts; a missing or unreadable file, an unknown target, a troop the army doesn't have, or an enemy stack a patch removed just means fewer starts — today's search. A patch that moves stacks is followed by unit (the file keeps each target's enemy units).

**Rebuilding after a patch** (machine-local scripts in `research/monster-sim/bench/`; the launchers run at Idle priority and at most 16 shards — `lowprio.mjs`, the user's PC stays usable — so about five to six hours):
1. Dump the shared reports (`echo "SELECT entry_id, target_static_id, report_at, summary FROM battle_reports …" | ssh tb-read sql`, and `hex(raw)`), then `npx tsx armies.mts <battle-data.json> <summaries.tsv> <raw.tsv> armies.json`.
2. `npx tsx ds-armies.mts armies.json r2/armies.json`, `node parg.mjs 30 r2/scenarios.jsonl ds-scenarios.mts r2/armies.json`, `npx tsx ds-citadel.mts r2/citadel.json`.
3. `node r2-run.mjs 30 h 1.5e8 1 train,test - 2` and `node c-run.mjs 8 c 1.5e8 1 1 train,test` (resumable).
4. `npx tsx lib-build.mts ../../../src/web/public/data/army-starts.json 2 h --citadel c --all` (2 = answers per target), then `npx vitest run tests/web/army-starts.test.ts` (format, ≤ 200 KB gzipped, the user's Elven 25/30 cards).
Loss prices come from battle-data's `train` (format 4; `r2/silver.json` holds the same prices for an older file). A patch does not need a rebuild: roles are shares of an enemy stack's health and hits, so new unit numbers change the counts they give, not whether they apply. Rebuild when a patch adds targets (until then a new level borrows its family's nearest one; a new family gets no learned starts — the search as in round 1) or reshapes many armies.

## Open

- **Epics are not meant to be beaten** (the user, Nov 28 2026): against an epic, a boss or the Tin Man the aim is the most hits and damage before the army falls, the cheap stacks taking the losses — the stacking calculator's job. Auto there should maximise damage dealt (`dealt` in the engine's result) within the march's leadership / authority / dominance (each unit's cost is in the data; a player's limits are at least what their own battles used), not search for a win. The one-row-at-a-time search needs trade moves (capacity from one troop to another) for that; on a 28-troop suggestion it settles in under a second, at a local best that can still lose a mercenary stack whole.
- **Learn from the searches**: done offline ([learned starts](#learned-starts-round-2-nov-28-2026)); not needed for load — the count search runs in each player's own browser (battle-sim.js), never on the server, so more players add no server work. Learning from players' own searches online (keep each search's best answer by target and hand the nearest to the next one) would add the newest armies between rebuilds; not worth a server store yet.
- Tools → Stacks on this data and engine: the stack plan checked (or sized) against the actual epic, the costs and every mercenary from the game.
- **The search on monsters is generic and unproven against a specialist.** On citadels it lost thousands of T8 guardsmen on Elven 30 where Tools → Citadel, with the player's own chosen army, loses 124–198 Corax I (the user's comparison, Nov 28 2026) — worse even by its own revival-gold measure (~25k gold vs ~10k): a local search over the troops of one battle, without Citadel's composition rules (a first striker sized for the strongest stack and its opening hit, one siege engine, cleanups). Citadels are now Citadel's alone (the Monsters picker links there). Round 2 taught it those starts as data (game01master's answers as templates beside the best known) and measured it on citadels: the user's cards reach Citadel's answers without game01master ([learned starts](#learned-starts-round-2-nov-28-2026)).
- Citadel on battle-result.js; a "suggest from my latest battle" there too.
- Saved armies for this tab.
- Reports with "rounds 0" and no strike log: Common squads against a far stronger army are won without a fight. The threshold is not known.
