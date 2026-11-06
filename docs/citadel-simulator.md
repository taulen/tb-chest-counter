# Citadel simulator (Tools → Citadel)

Plays a citadel attack out strike by strike, for both coin flips, from the troops and bonuses a player enters. The rules and data are in [citadel-sim.js](../src/web/public/lib/citadel-sim.js); the page is [citadel-tool.js](../src/web/public/pages/citadel-tool.js). Saved armies are per account: `citadel_presets` (v95), [citadel-preset-repo.ts](../src/data/repositories/citadel-preset-repo.ts), `GET/PUT/DELETE /api/tools/citadel-presets`.

## How the rules were obtained

Nothing here is guessed. Real battle reports (Nov 2026: Elven 10, 15, 20, 25 and 30) were decoded number by number. [citadel-sim.test.ts](../tests/web/citadel-sim.test.ts) replays 12 of them strike for strike, including the losses, so a changed rule fails the suite. Several were tests designed to tell two explanations apart.

- **Siege.** It only happens while the walls stand. Siege engines strike first (initiative +5 in a siege), then the walls (11), then everything else (10), which hits the walls. Rounds repeat until the walls fall. Walls do hit flying troops. Siege engines deal ×20 to fortifications on top of their "vs fortifications" feature. Units the walls kill are lost; the walls' wounds heal before the battle (5 Fire Phoenix I took 104.6M in total and lost none).
- **Turn order.** A coin flip decides who opens round 1. After that, the side that did NOT act last opens the next round; it is not a new flip. Within a round the sides alternate, each using its strongest stack that has not acted yet. When one side runs out, the other side's remaining stacks act back to back. Stack strength for ordering is units × strength × (1 + bonus); features play no part.
- **Targeting.** A stack hits the enemy it would deal the most damage to. Features ("vs mounted +667 %") are ADDED to the bonus, and the damage is capped at what the target has left. Ties go to the target that would hit back hardest. That last rule is why a Fire Phoenix picks the Bear (+50% vs elementals) over the Ent. It is also why game01master rounds DOWN: one Royal Lion I more and its plain damage beats the Centaur's 382.2M, so it hits the Ent instead.
- **Damage and losses.** Damage = units × strength × (1 + bonus + matching features). A stack's health is a pool; units alive = ceil(pool ÷ unit health), and a damaged stack strikes with those units. **Wounds stay through the whole battle, for every troop kind:** guardsmen (Corax I 211/114 to the unit), specialists (Royal Lion I), monsters (Fire Phoenix I), mercenaries (Wyvern) and siege engines (Catapult V). Counting each hit on its own fits none of the reports.
- **Luck** is not simulated: double damage, blocking a third, striking a second squad. The tests replay it through `luck` so the reports match exactly.

## Data

- **Troops:** base strength and health from game01master's data and the in-game cards. Features and tags come from [totalbattlewiki.com](https://totalbattlewiki.com) and were checked against six game cards. **Siege health is game01master's (6× strength):** the Siege Ballistae VII card reads 51,000; the wiki halves every siege engine.
- **Defenders:** every Elven and Cursed unit's card (stats, features, race) was checked in game. Counts per citadel come from in-game march screens. The wiki says Elven 10 has 200 Druids; the game has 100.
- **game01master's sizing** (Elven 25/30 only, `gmCounts`) reproduces its calculator exactly (621/26/166/779 for the reference army). Its Bear target is deliberately under the real 792M / 158.4M, so the Phoenix's damage stays below the Bear's health and it doesn't switch to the Ent. Its "first strike losses" counts only the dragon's opening hit; the simulator counts every hit.

## Automatic counts

`optimizeCounts` searches, for ANY citadel, the counts of the chosen troop types that win both coin flips with the fewest losses. Losses are weighed by each troop's base health, and ties go to the smaller army. It is a local search over each row's count. It tries the breakpoints where a stack's damage crosses a defender's health (the counts where its target can change) plus plain nudges. Starting points: every stack big enough to one-shot the biggest defender, game01master's counts, and the player's own counts. Every candidate must ALSO win with all bonuses 3% lower (`SAFETY`), and its losses are averaged over both, so it can't settle on a count that only works to the last unit.

On the user's Elven 30 army (Corax I, Phoenix I, Royal Lion I, Ballistae VII) it finds 94 / 174 Corax I against game01master's 132 / 211. It does that by leaving 41 Centaurs alive, whose weak strike lands harmlessly on the Ballistae. On Elven 25 it finds 21 / 37 against 26 / 43. With four flying cleanups added it matches game01master + cleanups (69 / 149).

## The page

- **What the player fills in:** the strength bonus for every troop, and the health bonus only where the page says "needed". A troop with no health counts as untouchable (`UNKNOWN_HEALTH_FACTOR`). That can only make it a likelier target, so if it still isn't hit, its health doesn't matter. If it is hit, the page asks for it and names the attacker. In game01master's mode the first striker always needs health, because its count depends on it.
- **Counts:** Auto (the search above, every citadel, the default), game01master (Elven 25/30, its exact sizing, roles by row order) or Manual. Worked-out counts are shown as results, not input boxes. The search runs 350 ms after the last keystroke.
- **Bonuses are never filled in for the player.** They change with every captain, artifact or research swap. The note says when they were typed or saved.
- Recommended setups bring troop types only (Elven 10–15 Wyverns; Elven 20 Wyverns + a Fire Phoenix I; game01master's troops + 4 cleanups for 25/30). The player's own bonuses carry over for troops they already had.
- The unsaved draft stays in this browser (localStorage); saved armies live on the server, at most 50 per account.
- Troop icons are game01master's (non-commercial licence, credited on the page and in `img/troops/NOTICE.txt`).

## Open

- Whether a second squad hit (5% luck) can double, and how blocks round, has not been needed yet.
- Cursed citadels have no game01master template and no battle report yet. Their unit data is checked, the fight model is assumed to be the same.
