# Chest identity

Chest *records* are keyed properly: `chest_records.chest_id` → `chests.id`, so a rename never loses data. What is keyed by **name** is the configuration layer, and that is where renames bite:

- `src/config/event-catalog.ts` literals, `source_point_overrides.chest_name` / `.source_key`, `chest_type_overrides.chest_name`, `triumphal_chest_points.chest_name`, `merge_rules.from_value` / `.to_value`.
- The game exposes **no chest id** — everything arrives as an OCR'd string — and `chests.id` is a per-install autoincrement that a committed source file can't reference. So a name is the only possible entry point; the fix is never "use ids in the catalog", it's that a stranded name must not be silent.
- Every one of those surfaces fails identically: **a zero that reads like a result.** That is why the Ragnarok/Jörmungandr rename went unnoticed for weeks.

Three things now stand in the way, in order of when they fire:

1. `tests/config/event-catalog.test.ts` asserts `correctChestName(name) === name` for every declared chest. `cleanupChestNames` reconciles `chests` through that function on every boot, so a name it would rewrite is one no row can hold. Runs as part of `npm run build`.
2. `resolvePredicate` ([event-repo.ts](../src/data/repositories/event-repo.ts)) resolves exact → corrected → accent-folded, so a stale literal still gets the right number, and flags itself on the page and in the log instead of dropping the rule.
3. `checkConfigIntegrity` ([config-integrity.ts](../src/data/config-integrity.ts)) sweeps every name-keyed table at boot. Errors light the System nav dot; warnings are `noAlert`. Returns nothing on a database with no chest records — a fresh install has an empty `chests` table and pre-declaring a chest is supported.

`cleanupChestNames` must carry a rename into all four config tables. For `merge_rules` only `to_value` moves — `from_value` is the bad spelling the rule exists to catch, and repointing it deletes the rule as a self-loop.
