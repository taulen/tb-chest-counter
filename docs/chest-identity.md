# Chest identity

Chest *records* are keyed properly: `chest_records.chest_id` → `chests.id`, so a rename never loses data. What is keyed by **name** is the configuration layer, and that is where renames bite:

- `src/config/event-catalog.ts` literals, `SOURCE_CHEST_POINTS` and `CHEST_TYPES` in the source tree; `source_point_overrides.chest_name` / `.source_key`, `triumphal_chest_points.chest_name` in the database.
- Chests are stored by **name**. Since Nov 17 2026 every chest arrives under the game's own name (the scan maps a gift type to a chest name and a source name, [protocol-scan.ts](../src/scheduler/protocol-scan.ts)), written verbatim: **the game's names are the names**. Nothing maps a game name onto an older spelling and nothing folds spellings together (Nov 25 2026); v139 moved the last 14 OCR-era source spellings ("Lvl 25-29 Vault of the Ancients", "Bank Delete") onto the game's, and every stored chest, every hand-written list and every chest-keyed point value already used the game's exact names. Two OCR junk rows with no game equivalent stay as history (chest "Connection lost"). `chests.id` is a per-install autoincrement that a committed source file can't reference, and the game's gift type is a chest *and* a source, so a name is the only possible entry point; the fix is never "use ids in the catalog", it's that a stranded name must not be silent.
- Every one of those surfaces fails identically: **a zero that reads like a result.** That is why the Ragnarok/Jörmungandr rename went unnoticed for weeks.

Three things now stand in the way, in order of when they fire:

1. `tests/config/chest-name-literals.test.ts` asserts that the hand-written lists (Events catalog, `SOURCE_CHEST_POINTS`, `CHEST_TYPES`, `TRIUMPHAL_CHEST_NAMES`) spell each chest one way — no two literals an accent, a case or an apostrophe apart — trimmed and single-spaced. Runs as part of `npm run build`. There is no committed list of the game's names to test against (the static data is downloaded at run time); on Nov 17 2026 every literal was checked against it and all matched except the OCR misread "Ore Chest", which went.
2. `resolvePredicate` ([event-repo.ts](../src/data/repositories/event-repo.ts)) and `clanRewardChestIds` ([clan-reward-chests.ts](../src/data/clan-reward-chests.ts)) resolve exact → accent/case/punctuation-folded, so a stale literal still gets the right number, and flag themselves on the page and in the log instead of dropping the rule. Two stored rows folding together resolve to the oldest, the spelling the scan resolves a game name to.
3. `checkConfigIntegrity` ([config-integrity.ts](../src/data/config-integrity.ts)) sweeps every name-keyed table at boot. Errors light the System nav dot; warnings are `noAlert`. Returns nothing on a database with no chest records — a fresh install has an empty `chests` table and pre-declaring a chest is supported.

Stored names are history: nothing renames a `chests` row on boot any more. The OCR-era corrector (`correctChestName`, its name catalog and `cleanupChestNames`, which reconciled every row through it on each boot) went with the screenshot scanner; nothing produces misread spellings now, and the old ones were folded long ago. Merge rules (and the Admin Chests tab that wrote them) were removed Nov 25 2026, v137 drops `merge_rules`; a chest the game renames is folded with a migration. A clan restore lands a backup's chest on the live row of the same exact or folded name ([clan-restore.ts](../src/data/clan-restore.ts)).

## Chest types

A chest's type (common, uncommon, rare, epic, legendary, arena) is a **display category** — the type badges and the by-type breakdowns. Points never key on it: they key on (source, chest name) ([chest-points-history.md](chest-points-history.md)).

- **`CHEST_TYPES`** ([chest-names.ts](../src/data/chest-names.ts)) lists every chest the site does not count as common: the Chests of Wealth by the rarity in their name, the epic- and rare-crypt chests, the citadel chests, Gladiator's Chest (arena), the Bank chests by package size, and the Omen summons. Anything not listed is common.
- **Per record**, the crypt's kind outranks the chest's own type: `chest_records_v.chest_type` is `COALESCE(chest_sources.rarity, chests.chest_type)` (v83, `getSourceRarity` — the game's source name says "Level 20 epic Crypt"), so a Barbarian Chest from an epic crypt reads epic.
- `syncChestTypes` applies `CHEST_TYPES` to stored chests on every boot; a name it doesn't declare keeps the type it was first stored with. The scan stores `chestTypeFor(name)` for a chest's first record.

**Why not the game's own grade.** The game's only grade for an item is its quality (T8 f10, the forge's ladder 1 Poor … 8 Godlike). Checked against all 97 chest names on prod (Nov 17 2026), it is not a chest category:

- It belongs to a gift type — chest *and* source — and follows the crypt or monster **level**: Barbarian Chest is grade 2 from a Level 5 Crypt and 6 from a Level 25 one. Read as common (1–2), uncommon (3), rare (4), epic (5), legendary (6+), 50 of the 97 names (555k records) span several types.
- Of the other 46, 36 would change type: every event chest to legendary (grades 6–8: Hermes, Union, both Golden Guardians, Olympus Elite, Jörmungandr's, Fenrir's …), Gladiator's Chest to common (grade 1), Pacified Mimic Chest to common, every Bank chest one step up (Wooden 3 … Magic 8), the Omen summons to epic/legendary. Only the five Chests of Wealth (grades 2–6) line up.

Changing those would move every analytics breakdown and badge for history that hasn't changed, so the list stays the site's own and no stored type changed.
