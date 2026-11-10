# Chest points history

Since v99 (Nov 2026) a clan's chest point values have a history. A value applies **from a game day**, and every chest record scores the values in force on the game day it was earned. Before v99 a save rewrote every stored record, so changing Common Crypt 20 from 20 to 0 also rewrote last month's leaderboards and the Performance page's past weeks. The clan leader asked for changes that only apply going forward, while keeping the option to fix a wrong value everywhere.

Code: [point-timeline.ts](../src/data/point-timeline.ts) (pure rules), [source-points-repo.ts](../src/data/repositories/source-points-repo.ts) (storage, recalculation), [points-board.ts](../src/data/points-board.ts) (saves, previews, the History view), [pages/points-board.js](../src/web/public/pages/points-board.js) (UI). Tests: `tests/data/points-history.test.ts`.

## Storage

- **`source_point_overrides`** holds each key's timeline. A key is (source key, chest name), and chest name `''` is the source-wide value.
  - `effective_from` is `''` for all history, otherwise the game day (`YYYY-MM-DD`) the value applies from.
  - `point_value` NULL means "from this day on, no value of its own". The chest then falls back to the source value, then the built-in default.
  - The value in force on a day is the latest row dated on or before it.
  - Unique on (clan, source key, chest name, effective_from).
- **`source_point_changes`** has one row per History entry:
  - `step`: a dated change. There is one per clan and game day. Its value rows point at it through `change_id`.
  - `correction`: a save to all history. Log only, with the lines it changed.
  - `copy`: "Copy from clan…". Log only, and `note` holds the other clan's name.
- The v99 migration turned every existing row into an all-history value, so nothing scored differently on the day it landed.

## The clock

A record resolves at `effective_at` (`COALESCE(earned_at, captured_at)`), the clock every ranking buckets by. A day starts at the game-day rollover (17:00 UTC). The scan pipeline loads the schedule once per scan and scores each chest at its `earnedAt` (`getPointsForSourceAt`). A chest earned before a change but scanned after it therefore still gets the old value.

## Saving from the board

The board always shows and edits **today's** values. Every save is previewed both ways, and the admin picks one:

- **From today on** (`mode: 'forward'`). The values are written as today's step, starting at today's reset.
  - A second save on the same day joins that step. As with the weekly goal history, the day's last word wins.
  - A dated row that only repeats the value in force the day before is dropped. A source-wide value equal to its built-in default counts as a repeat when the source has no per-chest defaults. So setting a value back leaves no step behind.
- **All history** (`mode: 'history'`). The written keys' whole timelines are replaced by one all-history value, and every record of those sources is recalculated.
  - Dated values of the same chests are removed. The preview lists the affected days (`replacesSteps`). A step left with no rows is deleted.
  - The save is logged as a correction.
- The dialog defaults to "from today on". The exception is when every edited source still needed a value (`unset`): those chests scored 0 everywhere, so the fix belongs to all history.

## Dated changes only write what they change

A dated write (a save from today on, editing a step, removing one) updates exactly the records whose value differs between the old and the new timeline (`changedRuns` → `applyTimelineChange`). A record outside that range keeps what it holds, **even if it was already out of line**. Only a correction, a copy or Recalculate rewrites everything.

This is not academic. On the Oct 25 backup, clan 1 had 93,463 records stored at clan 2's values. Clan 2's saves in the 11 minutes after v86 deployed (Oct 25 04:13) rewrote clan 1's records too. For example, clan 1's 4,607 Level 30 Citadel chests are stored at 500 while clan 1's value is 300. The old "recalculate the touched sources" save would have quietly rewritten those with any later save of the same source.

Out-of-line counts on the board ("N records out of date") compare each record with the value of **its own day**.

## The History view

- **Steps, newest day first.** Each step's lines are worked out from the timeline as it now stands. The board is built with the values of the day before, then compared with the values on the day (`boardEdits`). A line's "from" is therefore always true, even after an earlier step was removed. A step whose rows change nothing visible (pins only) says so.
- **Editing a step** sets its game day, its values (the board's terms, one per line; a line can be left out) and its note.
  - If the values are unchanged, the step's own rows are shifted to the new day.
  - Otherwise the step is re-planned against the values of the new day, exactly like a board save.
  - A step can't start after today, can't share a day with another step, and can't be moved past another step that sets values for one of the same sources. Their order would silently swap which one wins.
  - A step left changing nothing is deleted.
- **Removing a step.** Its days go back to the values before it, until the next change of the same chest.
- **Corrections and copies** are a record only, with no actions. A correction has already rewritten every recorded chest, so "removing" it can't restore anything. To undo one, save another correction.
- Changes made before v99 were all-history saves and aren't listed. The audit log (`set_source_points`) still has them.

## Copy from clan

This copies the values the other clan holds **today**, as all-history values. The target's steps go (the preview counts them as `dropsSteps`), and every record is recalculated. The copy is logged as a `copy` entry.

## Elsewhere

- `deleteClan` clears `source_point_overrides`, then `source_point_changes`.
- A clan restore copies the steps at fresh ids, then the rows with `change_id` remapped. A pre-v99 backup's rows become all-history values.
- Audit: `set_source_points` carries `mode` and `effectiveFrom`. `edit_source_points_change` and `remove_source_points_change` are visible to clan admins like the other scoring actions.
- **Not covered:** triumphal package values (`triumphal_chest_points`) are global and resolved when read, so changing one still re-prices every past Bank chest.
