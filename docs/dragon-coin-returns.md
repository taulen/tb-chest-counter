# Dragon Coins back to members (Clans → Dragon Coins back to members)

When a member collects an event reward that pays Dragon Coins, the game sends
those coins to the clan treasury under the member's name. A Leader or Superior
then sends each member theirs back by hand, one member at a time (CWB did 47 in
a row on Nov 6 2026). With this switch on, the clan's scanner account does that
after every scan.

Code: [game-protocol/dragon-coin-returns.ts](../src/game-protocol/dragon-coin-returns.ts)
(the plan, pure), [scheduler/dragon-coin-returns.ts](../src/scheduler/dragon-coin-returns.ts)
(the run, after the scan is final, on its game session),
[dragon-coin-return-repo.ts](../src/data/repositories/dragon-coin-return-repo.ts)
(v140: `dragon_coin_return_settings`, `dragon_coin_returns`), the Clans card
[pages/clan-dragon-coins.js](../src/web/public/pages/clan-dragon-coins.js) and
`GET/PUT /api/clans/:id/dragon-coin-returns` (requireClanAdmin).

## What is sent, and what never is

From the Clan Capital ledger (15031), which every scan already reads and keeps
in `game_ledger` ([game-protocol.md](game-protocol.md#messages)):

| Ledger kind | What it is | Sent back? |
|---|---|---|
| 4, resource 31 | one member's own event reward, arriving under their name | **yes**, to that member |
| 5 or 8 | what the **clan** won (Dark Omens, Olympus, the Seasonal Kingdom), credited to the Leader at the reset | **never** — nobody brought it in |
| 1 | a payout to a member: ours, or a Leader's by hand | used to confirm ours and spot hand payouts |

Only coins that arrive **after the switch went on** (`enabled_at`). Switching off
and on again starts from the new time; coins that arrived while it was off are
never sent.

## The send (15019)

Recorded Nov 26 2026 (1 Dragon Coin to one member): `[[[[31, amount]], [playerId]]]`
on the kingdom server, reply `[[]]`, and the very next 15031 lists a kind-1
entry for that member and amount. One member per request; the game has no
multi-send. Our encoding is byte-identical to the client's.

## Safety

- **Gates**: the clan's switch; `DRAGON_COIN_RETURNS_DISABLED=1` (docker-compose)
  stops every send on the server; the scanner account must be **Leader (1) or
  Superior (2)** in the roster the scan just read — otherwise nothing is sent and
  one System warning (resolveKey `dragon-coin-returns:rank:clan:<id>`) says so
  until it is.
- **Only members on the roster.** A member who left keeps their coins in the treasury.
- **Never more than the treasury holds**: its Dragon Coins are read fresh
  (the Clan Capital's 601) before sending; a member whose coins don't fit waits.
- **Reserved before sent**: each send is a `dragon_coin_returns` row
  (`sending`) listing the ledger entries it pays back, written in a transaction
  that refuses any entry another live send covers. A member's coins can't go
  out twice — restarts and redeploys included.
- **The ledger decides**: after sending, the ledger is read again and each send
  is matched to its kind-1 entry (same member and amount, not before we sent).
  A send with no clear answer (`unknown`: an odd reply, a timeout) is never sent
  again while it could still show up; one the ledger hasn't shown after 15
  minutes (`UNCONFIRMED_AFTER_MS`) did not go through and its coins go again,
  at most 3 times (`MAX_ATTEMPTS`), then they stay for a Leader.
- **Paid by hand**: a kind-1 payout no send of ours claims, after the switch went
  on, to that member, after their coins arrived, of exactly that amount (or of
  everything they had waiting) means a Leader already paid it: those coins are
  not sent. A payout of anything else (older coins, a share of a clan reward)
  doesn't count.
- One send per member with everything they have waiting, up to 30 members a
  scan (`SENDS_PER_RUN`), 1.5–3.5 s apart (`TREASURY_SEND_GAP`).

## The card

On, since when, and sends in the last 7 days; a notice when the scanner account
can't send (its rank) or the server switch is off; what the next scan would send
(the same plan, from the stored ledger); coins left in the treasury and why
(paid by hand, left the clan, gave up after 3 tries); the last 25 sends with
their outcome (✓ sent and in the ledger, ? no clear answer yet, ✕ not sent).
