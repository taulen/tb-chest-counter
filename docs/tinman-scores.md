# Tin Man scores (Events → Ancients)

Rise of the Ancients standings, pasted in by an admin after each summon. The card sits on the Ancients tab and follows the selected run. Code: [tinman-repo.ts](../src/data/repositories/tinman-repo.ts), [tinman-parse.ts](../src/data/tinman-parse.ts), [routes/tinman.ts](../src/web/routes/tinman.ts), [tinman-scores.js](../src/web/public/pages/tinman-scores.js).

- **The in-game ranking is cumulative.** It never resets between summons, so each paste is a full snapshot. A player's points in a summon are the step from their previous pasted snapshot. Someone missing from a later snapshot keeps their last total.
- **A missed summon is fine.** If summon 2 is never pasted, its points land on summon 3. The table shows S2 as "not uploaded" and S3 as "incl. S2". Re-pasting a summon replaces it, and deleting one moves its points to the next pasted summon.
- **Runs are keyed by their Tinman day,** the Rise of the Ancients game day and the run's last day. `/api/events/ancients/occurrences` carries it as `tinmanDate`. With the feed down, the newest Tinman day on the 6-day cadence is used.
- **Name matching follows the might capture's `resolveMember` order.** Player merge rules come first (exact only), then every exact pass on name, alias and despaced key across active and inactive members, then fuzzy matching with active members first. A member can be claimed once per paste, and the exact match wins.
- **Nothing creates a member.** An unknown name stays unknown until an admin assigns it under *Names to check*. An assignment applies to the whole run and records the spelling as the member's alias, so future runs match exactly. "Not a clan member" on a fuzzy guess sticks for the run's later pastes.
- **Storage** (v80): `tinman_uploads` holds one row per clan, day and summon, with the uploader stored as a username. `tinman_scores` keeps the pasted name next to the matched member. The `member_id` FK is SET NULL on delete, so the row falls back to its pasted name. A player merge repoints it, and clan delete and clan restore handle both tables.
- **Targets** (v81, `tinman_targets`, one per clan and run): an admin pastes the Ancient planner's *Points per member* card. Its "points each" per tier and its "For N kills" line are kept.
  - Each player is held to their tier's target: their estimated guards level, or G7 when unknown, never T9.
  - The target is always the whole run's, never split per summon: the clan judges the total, so mid-run everyone simply reads as not there yet. The kill count is kept for display only.
  - The goal colours (`goalStatusClassFor`: green at target, amber from 66%, red below) and their glyph + words are the Leaderboard's.
  - Players under target are listed in *Below Tin Man target* at the bottom of the page.
- **Formats** the parser reads: markdown tables, tab-separated rows, and plain `rank name points` lines. Points can use any thousands separator. Lines it can't read are reported back, never dropped silently.
