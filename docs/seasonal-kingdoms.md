# Seasonal Kingdoms (SK)

A Seasonal Kingdom is a 90-day tournament server ([help center](https://scorewarrior.theymes.com/hc/en/total-battle/articles/what-is-the-seasonal-kingdom-413)). Players from one kingdom land in the same SK. It plays like the normal game, with faster events and a few resources of its own. A clan playing one is marked on the Clans page (**Seasonal Kingdom** section, `clans.seasonal_kingdom`, v100). Chest scanning, might and level tracking don't change.

## What the flag changes

- **Event windows come from the SK calendar.** tbclanportal's calendar page has a "Normal kingdoms / Seasonal Kingdoms" toggle. Its SK feed is `https://tbclanportal.com/calendar/feed.ics?realm=season` (override: `EVENT_CALENDAR_SK_ICS_URL`). It uses the same format and 17:00 UTC days as the normal feed, but a different rotation. `getEventOccurrences` / `getEventSchedule` pick the feed from the clan ([event-calendar.ts](../src/external/event-calendar.ts)), so the Events page, the Tin Man and per-day score cards, Performance, the member event views and might all follow it without code of their own.
- **Each realm is fetched, cached and archived on its own.** `event_calendar_runs.realm` is part of the key, because both feeds list the same event keys, often starting on the same day.
- **Superadmin schedule corrections (System → Event Schedule) are normal-kingdom only.** They are keyed by event and feed start. An SK run starting the same day would otherwise be moved too.
- **Tinman-to-Tinman weeks run on the SK cadence: `week_start = 'ancients-sk'`, 5 days.** Like the normal 6-day `ancients`, it's pure arithmetic shared by server and client: `SK_TINMAN_ANCHOR` + `SK_CYCLE_DAYS` live in [game-day.ts](../src/utils/game-day.ts) and [lib/period.js](../src/web/public/lib/period.js), and `game-window-parity.test.ts` holds the two together.
  - Each kingdom holds only its own Tinman week. The week-start route refuses the other one, and the SK toggle converts `ancients` ↔ `ancients-sk` (Sunday weeks stay Sunday).
  - **The anchor is the first Tinman OF THE CADENCE, and it is per season.** SK 2026's first Tinman (Nov 13) came 4 days before its 5-day rhythm began on Nov 17. So the season's opening days sit in a week that starts a day early, and every week from Nov 17 on is exact.
  - A new season brings new dates. On each SK feed fetch, `checkSeasonalTinmanCadence` judges the **upcoming** Rise of the Ancients days on or after the anchor. Once they stop fitting, it raises a System-page warning saying to move both constants. It is quiet while no clan uses `ancients-sk`.
- **Tin Man scores** ([routes/tinman.ts](../src/web/routes/tinman.ts)): for an SK clan, the default run, the "isn't a Tinman day" warning and the "more than a cycle old" warning read the clan's SK Ancients runs, not the 6-day cadence. If that feed is down, the checks stay silent rather than guess.
- **Triumphal is unchanged.** The SK feed's Triumphal Challenge resets on the same instants the catalog's rolling 30-day anchor gives (2026-11-21 17:00 UTC in both).

## The SK 2026 schedule, as the feed listed it

The season opened on 2026-11-11 at 09:00 UTC and runs to 2027-02-08 09:00. Its first day runs from 09:00 to the 17:00 reset.

- **Ancients:** Ancients' Treasure (players call it "Vaults day"), then Rise of the Ancients (Tinman) the next day. Tinman fell on Nov 13, then every 5 days from Nov 17. The feed labels it "6-day rotation", which is wrong; go by the dates.
- **Ragnarök:** Nov 12, Nov 15, then every 5 days from Nov 19. The last run, Feb 5–8, is 3 days long.
- **Pursuit of Experience (Runics):** every 5 days from Nov 20.
- **Not listed at all:** Trials of Olympus, Dark Omens. An SK clan gets no runs for those; the Events page falls back to its fixed Weekly/Monthly selector.
- **SK-only events in the feed** (Gifts of the Forest, Forest Mysteries, Lucky Bazaar, Summon Mastery, Pinnacle of Warfare, Path of Legend) aren't in the event catalog. Their chests are still counted like any other gift.

## SK resources: Forest Essence and Magic Seeds (v100)

These are seeded in `resource_types` and ship as `assets/resource-icons/forest-essence.png` and `magic-seeds.png` (the icons the UI shows; they were cut from the history page's resource dropdown, Nov 13 2026). Their rows arrive from the Clan Capital ledger every scan reads, mapped by name like every other resource (Magic Seeds = ledger resource 74284, Forest Essence = 74285; [game-protocol.md](game-protocol.md)).

`tGame()` has no official es/fr/ru/de names for them yet, so they display in English (docs/i18n.md: a guessed name is worse than English).
