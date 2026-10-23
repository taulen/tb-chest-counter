# Ancient planner (Tools page)

A replica of [totalcalculator.org/summons.php](https://totalcalculator.org/summons.php), prefilled from the clan's roster. The arithmetic is in [ancient-planner.js](../src/web/public/lib/ancient-planner.js); the roster comes from [ancient-roster.ts](../src/data/ancient-roster.ts) via `GET /api/tools/ancient-roster`, which is open to every role.

## How the numbers were obtained

The reference computes on the server and publishes no source. Its form is a plain GET, so it was probed with controlled inputs (one member at one tier, one variable at a time) and the outputs were fitted. [ancient-planner.test.ts](../tests/web/ancient-planner.test.ts) replays 138 recorded responses ([fixture](../tests/fixtures/ancient-planner-reference.json)), so a changed constant fails the suite.

- **Vault points per member** are a fixed amount per tier (G1 1,000 … G9 8,200; T9 = G9). "Vault trick" moves a member one vault level up: G1→1,100 … G7→5,100, and G8→8,200. G9 and T9 can't go higher. The pot is floored.
- **All three artifacts share one 28-level cumulative cost ladder** (0, 1.8k … 572k). The Tome's 28 bonus values and the Clock's 28 minute values sit on it. The in-game screen agrees: Tome 26 = +70%, Clock 16 = 37 min.
- **The reference buys the Figurine and the chosen Tome first, and gives the Clock the rest.** That is the reverse of TB Clan Portal's planner, where the Tome takes the rest.
- **Every summon is a kill**, one level higher each time, and levels past 250 use 250's HP. Target = Σ HP × (1 + Tome bonus). Each member's share is target × weight ÷ Σ(members × weight) ÷ (1 + overshoot).
- **Tin Man HP**: 1,000 at level 1, then ×1.5 (to 6), ×1.3 (to 11), ×1.2 (to 31), ×1.12 (to 51), ×1.05 (to 100), ×1.04 (to 151). This is exact. From 152 up, no clean multiplier fits (there is a bump at 184–185), so the values were pinned to ±0.04% by intersecting the rounding intervals of many differently-scaled readings of each level.

## Known disagreements / open questions

- **Figurine 7 and 8 summons** cost 185k / 278k here (ladder levels 22 / 24). TB Clan Portal documents 153k / 230k (levels 21 / 23). Neither has been checked in game.
- **Tier weights** are the reference author's convention ("chosen somewhat arbitrarily"), not game data.
- **T9 can't be inferred.** The guards estimator only knows G levels, so prefilled T9 is always 0 and those members land in G9.

## Roster rules

The roster prefers the newest might capture if it is at most 2 game days old, strongest first, capped at 100. Otherwise it uses active members seen in the last 7 days, most recent first, capped at 100. Members with no guards estimate are counted at the clan's most common level by default; the page lets the user change that or leave them out.
