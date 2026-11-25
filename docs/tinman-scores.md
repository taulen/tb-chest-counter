# Event scores (Events → Ancients, Olympus, Ragnarok, Dark Omens)

An event's own scores, from the game: Rise of the Ancients per summon, and Trials of Olympus, Ragnarok and Dark Omens' Spoils of Dread damage per day. **Nothing is pasted any more** (Nov 25 2026). The standings are read every scan, and every ~10 minutes between scans while Ancients runs, and each run's table is built from them. One source serves every reader: [event-scores.ts](../src/data/event-scores.ts) feeds the Events cards (through [routes/tinman.ts](../src/web/routes/tinman.ts)), Tools → Rewards, the member profile's Events card ([member-events.ts](../src/data/member-events.ts)) and the Performance page's Tin Man signal ([performance.ts](../src/data/performance.ts)). Before this the profile and Performance read only the pasted rows, so they missed every game-read run from Nov 17.

| Event | Built by | Columns |
|---|---|---|
| Ancients | [ancients-game.ts](../src/data/ancients-game.ts) | Summons, split from the game's own "Summons left" ([game-protocol.md](game-protocol.md#rise-of-the-ancients-per-summon-v123)); back-to-back summons the reads can't split are one column ("S2–3"). |
| Olympus | [olympus-game.ts](../src/data/olympus-game.ts) | The five days with their stages (below). |
| Ragnarok, Dark Omens | [day-event-game.ts](../src/data/day-event-game.ts) | The run's game days. The ranking is cumulative: a day's points are the step at its 17:00 UTC end; the last day keeps every read until the run closes. A one-day run (Seasonal Kingdom Ragnarök, Nov 2026) is one column. |

- **Runs pasted before the game read them stay readable**, read-only ([tinman-repo.ts](../src/data/repositories/tinman-repo.ts)): Ancients runs before v123, Olympus before Nov 24 2026, Ragnarok and Dark Omens before Nov 25. A run with both is the game's, except an Ancients run read before reads were kept (v123, totals only), which keeps its pasted per-summon table. A pasted run shows its upload chips (who, when, how many names unmatched) and a missed summon as "not uploaded" / "incl. S2".
- **Dark Omens is unverified.** No run had been read when its table was built (Nov 25 2026). Its runs are found by title ("Dark Omens", [event-mapping.ts](../src/game-protocol/event-mapping.ts)); check on its first run that the ranking the game answers for it is the Spoils of Dread damage one the tab and Rewards show. If the damage ranking turns out to be a run of its own (as Olympus' stages are), map its title onto `dark-omens`.
- **Runs are keyed** by their Tinman day for Ancients (the run's last day; `/api/events/ancients/occurrences` carries it as `tinmanDate`), and by their first game day for the per-day events (`scoresDate`). With no `?date=`, the newest run with scores is shown (Ancients: the newest Tinman day).
- **API:** `/api/tinman` (Ancients) and `/api/event-scores/<event>`, GET only, plus Ancients' targets and vaults. The response carries `game` (columns, live, read time…) for a run from the game, else `summons` (the pasted uploads).
- **Players are the game's**, each with their member when one is linked to the player id. A pasted run's unmatched names stay as their own rows.
- **Storage:** `tinman_uploads` / `tinman_scores` (v80, `event_key` v90) hold the pasted history; nothing writes them now. Clan delete and restore still handle both tables.

## Targets (Ancients)

`tinman_targets` (v81, one per clan and run): an admin pastes the Ancient planner's *Points per member* card, or types one line per tier (`G7 1.3M`). This is a plan, not a score, so it is still pasted ([tinman-parse.ts](../src/data/tinman-parse.ts)). Its "points each" per tier and its "For N kills" line are kept. Targets can be saved up to one cycle ahead: a run is filed under its Tinman day, its LAST day, so a live run's date is still in the future until then.

- Each player is held to their tier's target: their guards level (the Guardsmen tier from research), or G7 when unknown, never T9.
- The target is always the whole run's, never split per summon: the clan judges the total, so mid-run everyone simply reads as not there yet. The kill count is kept for display only.
- The goal colours (`goalStatusClassFor` with its default ratio judge: green at target, amber from 66%, red below) and their glyph + words come from `lib/leaderboard-render.js`. The clan's points goal judges by pace instead (`{ pace }`); a Tin Man target has no clock.
- Players under target are listed in *Below Tin Man target* at the bottom of the page.

## The card

[tinman-scores.js](../src/web/public/pages/tinman-scores.js). Every event's sentences are shared per kind: Ancients has its own, `dayEvent()` builds Olympus, Ragnarok and Dark Omens', so only the name and the API differ. Dark Omens' card is titled "Spoils of Dread damage" and its view tab reads *Damage*, because the event's other measure, Omen Essence donated, sits in the Essence column under *Participants* (resource tracking). Both feed Tools → Rewards ([rewards-tool.md](rewards-tool.md)). Adding another scored event means a builder, its key in `SCORE_EVENTS` (tinman-repo.ts), `SCORES_EVENT_KEYS` (events.js), the occurrences route in api.ts and the mount loop in server.ts.

## Olympus from the game

Since Nov 24 2026 the Olympus card fills itself for every run ([olympus-game.ts](../src/data/olympus-game.ts), protocol in [game-protocol.md](game-protocol.md#trials-of-olympus-v136)), marked **From the game**. The card shows:

- **The five days with their stages** (D1 Trial of the Chimera … D5 Trial of Briareus), the running day marked, days still ahead dimmed.
- **Overall points per day** (the members' Olympus points), the default view. This is the ranking admins used to paste before: the umbrella event's Clan members tab, read every scan and kept with history. A day's points are the step between the reads either side of its 17:00 UTC end, so points scored after a day's last scan land on the next day. Day 5 has no next day: it keeps every read until the event closes an hour after its end, so its total is the final one — provided a scan lands in that closing hour (17:00–18:00 UTC); the event isn't read once it has closed. Total and rank are the game's.
- **Stage points**, the toggle. Each day's stage has its own ranking, which starts from zero, so the total is their sum. A run read before Nov 24 2026 has stage points only and shows no toggle.
- **The clan ranking**: the matchup's clans, best first, with the clan's own row in gold, each rival's tag, name, kingdom ("Kingdom #157") and members, and how far the clan is from the reward minimum.

Tools → Rewards splits by the same Olympus points, as they stood after the picked day ([rewards-tool.md](rewards-tool.md)). Runs are keyed by their first game day, as pasted ones are: stage n read on game day d belongs to the run that started on d − (n − 1).
