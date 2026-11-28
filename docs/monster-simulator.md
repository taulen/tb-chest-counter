# Monster simulator (Tools → Monsters) and the game's battle data

Plays an attack on any monster target out strike by strike, for both coin flips: every Common, Rare, Heroic, Legendary and Epic squad level, the event bosses, the Tin Man, raids and vaults. Built on the same engine as Tools → Citadel ([citadel-simulator.md](citadel-simulator.md)), with every number taken from the game's own files instead of typed in.

## The data: battle-data.json

[battle-data.ts](../src/game-protocol/battle-data.ts), built by the names build once per game patch beside names.json (`NAMES_FORMAT` 17, [static-data.ts](../src/game-protocol/static-data.ts) `makeBattleData`), loaded by [data/battle-data.ts](../src/data/battle-data.ts) and served at `GET /api/tools/battle-data` (ETag = the static-data version, `private, max-age=600`, gzipped; 370 KB, 57 KB gzipped on Nov 28 2026). A patch whose armies can't be read keeps the previous patch's file and logs a warning.

- **Units** (T9): name, tier, strength, health, tags, "vs" features with their damage multiplier, icon. A unit a player can send also carries its kind and march cost: `kind` from the cost (authority → mercenaries, dominance → monsters, leadership → guardsmen / specialists / siege by tag). Field meanings: [game-protocol.md](game-protocol.md) (T9 Units). Nov 28 2026: 35 guardsmen, 36 specialists, 30 monsters, 10 siege engines, 140 mercenaries (113 names; Bull Rider, Sphynx and others are two or three different units), and 599 units of the map's armies. The game's 75xxx copies of trained troops and mercenaries (same numbers, no march cost) are left out; armies carry the lower id.
- **Targets** (T7 type 6 with an army): name, level (f15), class (f18), army `[[unitId, count]]`, strongest stack first, walls included. One target per name, level and army: where the same name and level has a current version and an older one (class 0), the older steps aside; identical armies under several ids are one target listing every id. Objects whose name key has no text in the game's files (tutorial and test objects) are left out, and so are Exiles' Grove (type 22) and player cities. Nov 28 2026: 1,915 targets.
- **Names in every language**: names.json `units` holds the same units' names, so the texts build pairs them with the game's own text ([i18n.md](i18n.md)); map objects' names were already there.

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

## Open

- Tools → Monsters itself (the page) is being built; this file grows with it.
- Reports with "rounds 0" and no strike log: Common squads against a far stronger army are won without a fight. The threshold is not known.
