# Rewards tool (Tools → Rewards)

Shares a clan reward pot (Dragon Coins and clan fragments) over the players of one event run, in proportion to their score. It replaces [totalcalculator.org/rewards.php](https://totalcalculator.org/rewards.php), which takes hand-typed `name>score` lines, with the clan's own scores. Code: [rewards-tool.js](../src/web/public/pages/rewards-tool.js) (page) and [rewards-split.js](../src/web/public/lib/rewards-split.js) (arithmetic, tested in `tests/web/rewards-split.test.ts`). Its one route of its own is the pots' (below); the scores come from existing endpoints.

## The pots: what the clan won, from the ledger

The pots fill themselves from the Clan Capital ledger: `GET /api/resources/clan-winnings?at=<the run's resetAt>` → `{ winnings: { creditedAt, coins, fragments: [{ itemId, name, amount }] } | null, ledgerSince }` ([clan-winnings.ts](../src/data/clan-winnings.ts), tested in `tests/data/clan-winnings.test.ts`).

- **What it reads**: ledger kinds 5/8, what the clan itself won, credited to the Leader at the run's reset and never shown in the in-game history ([game-protocol.md](game-protocol.md#messages)). Dragon Coins are item 31; a clan fragment is any item whose game name ends in "Clan Fragment" (Olympus pays the Torch of Olympus one, 701216). Scientific Tractates come in the same credit and are left out: the clan keeps them.
- **Matched by time**, since no entry names its event. One win's entries land within the same minute of the game's reset (CWB's Olympus on Nov 6 2026: all three at 18:00:19). The calendar's run end can be an hour off the game's (Olympus: 17:00 in the feed, 18:00 in the game), so entries are looked for from 2 h before to 4 h after it, and the credit nearest to it wins.
- **Proven on one run so far**: CWB's Olympus of Nov 1–6 2026 (525,000 Dragon Coins + 700 fragments; the 700 went out to 59 members the next day). The ledger has been kept since Nov 3 2026, so older runs have nothing and say so. Dark Omens' win is expected the same way but no run has ended since.
- **On the page**: picking a run fills both boxes and names where the numbers came from and when. A number typed over one stays until another run is picked, and *Use the ledger's totals* puts the ledger's back. A run still going (or ended under 4 h ago) says its win fills in after the next scan. A credit with two kinds of clan fragment fills only the coins.

## Where the scores come from

| Event | Basis | Read from |
|---|---|---|
| Olympus | Points | `/api/event-scores/olympus?date=<scoresDate>`: the members' Olympus points read from the game (`game.days` + each player's `cumulative`) |
| Dark Omens | Omen Essence donated (default) | `/api/resources/summary?from&to` over the run's window, the same numbers as the Essence column on Events → Dark Omens |
| Dark Omens | Spoils of Dread damage | `/api/event-scores/dark-omens?date=<scoresDate>`, read from the game ([tinman-scores.md](tinman-scores.md); unverified until a Dark Omens run is read) |

Nothing is pasted any more (Nov 25 2026); a run pasted before the game read it keeps its pasted ranking, with its pasted days.

- **Runs** are `/api/events/<event>/occurrences`, newest first, capped at 12. If the calendar feed is down, a scores basis falls back to the dates of the runs with scores. Essence then has no window and says so.
- **The ranking is cumulative**, so "Scores after day N" reads each player's points as they stood after day N (`scoreAfterDay`), carrying a missed day forward the way the Events card does. The default is the latest day.
- **Essence comes from the Clan Capital ledger**, which every scan reads for every clan. A run with no Omen Essence donated in its window says so ("Nobody donated…"); split by damage instead.

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
