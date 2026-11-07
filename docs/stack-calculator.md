# Stack calculator (Tools → Stacks)

Sizes every stack of a march from one base stack, so the enemy wears down the cheap stacks first and reaches the valuable ones last. Mostly for epic monsters, crypts and other PvE. The rule is in [stack-calc.js](../src/web/public/lib/stack-calc.js); the page is [stacks-tool.js](../src/web/public/pages/stacks-tool.js). Saved armies are per account: `stack_presets` (v97) in [stack-preset-repo.ts](../src/data/repositories/stack-preset-repo.ts), `GET/PUT/DELETE /api/tools/stack-presets`. Troop levels are the Citadel tab's (`citadel_levels`, `/api/tools/citadel-levels`); one set per account serves both tabs.

## Where the rule comes from

It is a port of [Kaiculator](https://kaiculator.kaikaiju.com/) v0.71.5 ("estimated" mode), read from its published bundle in Nov 2026. [stack-calc.test.ts](../tests/web/stack-calc.test.ts) holds 14 armies entered on Kaiculator itself, driven headlessly through its own saved-settings format, and checks every count. Those cases cover plain stacks, specialists, health bonuses, monsters and mercenaries, siege, both dominance modes, mercenaries growing back, "Find it for me", tier multiplier 2 and the epic hunter. Change a rule and a count stops matching. To re-probe after a Kaiculator release, load the page in Playwright (system Edge), write `localStorage.uiSettings` (`{ referenceCount, selected: ['#<checkbox id>'], healthBonuses: [{ types: ['Flying'], value: 100 }], … }`), call `loadSettings()` and `updateTroops()`, and read each `#<id>-count`'s `data-count`.

The arithmetic follows Kaiculator's exactly: it multiplies by `1 / (1 + bonus)` and adds a bonus as `base / mult − base`. With plain division, one case in 14 came out 0.4% off, because a count landed on a rounding edge.

## The rule

- **Loss order = stack health, most first.** An enemy stack hits the stack it can hurt most; when it can finish any of them, that's the one with the most health. Stacks with exactly equal health fall as a group ("4–6").
- **Base stack:** the selected guardsman/specialist with the highest unit health. On ties, guardsmen win, then ranged → melee → mounted → flying (Kaiculator's list order). Its count is what the player sets, or what Fill finds.
- **Guardsmen and specialists:** `count = tierMultiplier^(baseTier − tier) × (TYPE[type] ÷ TYPE[baseType]) × r ÷ (1 + bonus)`, at least 1. Here TYPE is flying 1, mounted 10, melee/ranged 20: one flyer has the health of 10 riders or 20 foot soldiers in the same tier. Vultures (flying specialists below tier 8) count as melee. The raw size `r` comes from a binary search, so the base stack lands on the wanted count. With the default 1.9 against the ~1.8× unit health per tier, each tier lower carries ~5% more health. **Specialists first** (default on): a specialist gets `floor(maxGuardsHealthOfItsTier × 1.01 ÷ unitHealth) + 1` units, so it falls before the guardsmen of its tier.
- **Monsters and mercenaries:** walked in Kaiculator's processing order: strength ÷ health rounded, then strength, then tier, all ascending. Each gets `floor(cap ÷ hp) × 1/(1+bonus)` units; the cap starts at 97% of the base stack's health, and each stack sized becomes the next one's cap. So the weakest gets the biggest stack and the strongest falls last. **Epic hunter** option: the Epic Monster Hunter's +1000% epic strength counts in that order, so it sorts last and keeps the smallest stack.
- **Dominance over the limit** (only when a limit is entered): *keep the counts* only warns; *scale* multiplies every monster count by limit ÷ needed; *whole stacks* keeps monsters in processing order while they fit and drops the rest. When monsters were cut and an authority limit is entered, mercenaries grow back towards a full stack (97% of base), all by the same share, as far as the authority left allows.
- **Siege engines (decoys):** `ceil(biggestStackHealth × scale ÷ hp)`, where `scale = (1.15 + (baseTier − bestEngineerTier) × baseTier/9 × 0.25) × siegeMultiplier`. Ariel is a tier-9 siege mercenary and only sets the tier when no engineer is picked. Siege health bonuses are ignored, as in Kaiculator, and the siege multiplier is the knob instead. The page hides the box on siege rows for that reason.
- **Costs** (Kaiculator's table): guardsmen/specialists take 1 leadership, mounted 2, Griffins/Corax/Royal Lions 20 (Vultures 1). Siege engines take 10. Monster dominance and mercenary authority are per troop (`MONSTER_DOMINANCE`, `MERCENARIES`). Revival gold is 4 × leadership for trained troops, 40 per siege engine and 16 × dominance per monster.
- **Revival cost** = Σ floor(0.9 × count) × revival gold ÷ the Temple reduction (level 1–45, 1.04…5.91).
- **Fill my leadership:** Kaiculator's "Find it for me". It sizes once at base 100, scales to the leadership, and then steps to the exact edge: the largest base whose whole army, siege included, fits. In Fill mode it runs again on every change.

## Deliberate differences from Kaiculator

- No limit entered = no limit. Kaiculator drops every monster when its over-limit handling is on and the dominance box is empty.
- Siege engines count in the revival cost; Kaiculator leaves them out of the displayed figure.
- Health bonuses are one number per troop, the total from its card, with Citadel's family links (Corax I/II…). Kaiculator takes per-attribute bonuses (Flying, Guardsman, Human…) and adds them up. The cases above were converted the same way.
- Not ported: battle-report calibration, sub-tier stacking, the power score and the "enemy stacks" attack assessment, profiles shared by URL, and the 60-odd mercenaries we have no icons or citadel data for. Only the five mercenaries in `TROOPS` are offered.

## The page

- Three steps: troops (rows always in the troop list's order, no dragging), size and limits (base count Fill/Manual, leadership/authority/dominance, Temple, Fine-tuning folded away), and the stacks in loss order, with the leadership/authority/dominance used against your limits and the revival cost.
- Leadership, Authority, Dominance and Temple are the game's words and go through `tGame()`, so they stay English until an official name is in a dictionary.
- The troop picker is [troop-picker.js](../src/web/public/lib/troop-picker.js), shared with Citadel; the March list reuses `marchList` from citadel-sim.js.
- The draft is kept in this browser (`tbcc.stacks.draft.v1`). Saved armies live on the server: at most 50 per account, with the same name rules as the citadel presets (`parsePresetName`).
