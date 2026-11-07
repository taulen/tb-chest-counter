# Rewards tool (Tools → Rewards)

Shares a clan reward pot (Dragon Coins and clan fragments) over the players of one event run, in proportion to their score. It replaces [totalcalculator.org/rewards.php](https://totalcalculator.org/rewards.php), which takes hand-typed `name>score` lines, with the clan's own scores. Code: [rewards-tool.js](../src/web/public/pages/rewards-tool.js) (page) and [rewards-split.js](../src/web/public/lib/rewards-split.js) (arithmetic, tested in `tests/web/rewards-split.test.ts`). No server route of its own: it reads existing endpoints.

## Where the scores come from

| Event | Basis | Read from |
|---|---|---|
| Olympus | Points | `/api/event-scores/olympus?date=<scoresDate>`, the cumulative ranking pasted on Events → Olympus |
| Dark Omens | Omen Essence donated (default) | `/api/resources/summary?from&to` over the run's window, the same numbers as the Essence column on Events → Dark Omens |
| Dark Omens | Spoils of Dread damage | `/api/event-scores/dark-omens?date=<scoresDate>`, pasted on Events → Dark Omens ([tinman-scores.md](tinman-scores.md)) |

- **Runs** are `/api/events/<event>/occurrences`, newest first, capped at 12. If the calendar feed is down, a pasted basis falls back to the pasted run dates. Essence then has no window and says so.
- **A pasted ranking is cumulative**, so "Scores after day N" reads each player's newest snapshot at or before day N (`scoreAfterDay`), carrying a missed day forward the way the Events card does. The default is the latest pasted day.
- **Essence needs resource tracking.** A clan without it is told to split by damage instead.

## The split

- Every player gets `pot × score ÷ total` rounded down. The units left over go one each to the largest remainders, ties to the higher-ranked player. Everyone therefore lands on their exact share rounded down or up, and the parts always sum to the pot. It uses BigInt: a damage score (billions) times a coin pot (millions) is past what a double holds exactly.
- **Reference:** every Dragon Coins split probed on totalcalculator (2026-11-07) is reproduced exactly; the probes are pinned in the test. Its *fragment* splits are deliberately not copied. Which player gets a leftover fragment there shifts with the size of the coin pot (500 fragments over 100/50/25 is 286/143/71 beside 500 coins, 285/143/72 beside 501). That is an artifact of its ordering, not a rule, so a fragment amount here can differ from it by one.

## Leaving players out

- A ticked box per row. Unticked players get nothing, and their part is spread over everyone else by score (they weigh 0).
- Unticks are remembered per clan in `localStorage` (`tbcc.rewards.excluded.v1.<clanId>`, keys `m:<memberId>` or `n:<pasted name>` for unmatched names). A per-viewer convenience, never shared state.
- **Players the roster no longer lists** (not in `/api/members`) start unticked, tagged "left the clan": a reward can only be sent to a member. Ticking one back in lasts for the visit only.
- *Include all members* clears the hand-made exclusions for the players on screen.

## Output

The table keeps rank order (left-out rows stay in place, greyed). *Copy list* puts the recipients on the clipboard tab-separated with a header, which pastes into a sheet as columns and still reads in chat. Only pots that are above zero become columns.
