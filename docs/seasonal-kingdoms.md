# Seasonal Kingdoms (SK)

A Seasonal Kingdom is a 90-day tournament server ([help center](https://scorewarrior.theymes.com/hc/en/total-battle/articles/what-is-the-seasonal-kingdom-413)). Players from one kingdom land in the same SK. It plays like the normal game, with faster events and a few resources of its own. A clan playing one is marked on the Clans page (**Seasonal Kingdom** section, `clans.seasonal_kingdom`, v100). Chest scanning, might and level tracking don't change.

## What the flag changes

- **Event windows come from the SK calendar.** tbclanportal's calendar page has a "Normal kingdoms / Seasonal Kingdoms" toggle. Its SK feed is `https://tbclanportal.com/calendar/feed.ics?realm=season` (override: `EVENT_CALENDAR_SK_ICS_URL`). It uses the same format and 17:00 UTC days as the normal feed, but a different rotation. `getEventOccurrences` / `getEventSchedule` pick the feed from the clan ([event-calendar.ts](../src/external/event-calendar.ts)), so the Events page, the Tin Man and per-day score cards, Performance, the member event views and might all follow it without code of their own.
- **Each realm is fetched, cached and archived on its own.** `event_calendar_runs.realm` is part of the key, because both feeds list the same event keys, often starting on the same day.
- **Superadmin schedule corrections (System → Event Schedule) are normal-kingdom only.** They are keyed by event and feed start. An SK run starting the same day would otherwise be moved too.
- **No Tinman-to-Tinman weeks.** Those weeks are pure arithmetic on the normal kingdom's fixed 6-day cadence (`ANCIENTS_TINMAN_ANCHOR`). Turning SK on moves such a clan to Sunday weeks, and the week-start route refuses `ancients` for an SK clan. The Tinman cadence check runs on the normal feed only.
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

These are seeded in `resource_types` and ship as `assets/resource-icons/forest-essence.png` and `magic-seeds.png`. Both templates are **provisional**. The only images available were the history page's resource dropdown (two screenshots from the user, Nov 13 2026), not history rows, so they were cut as follows:

- **Segmented off the panel and recomposited.** The dropdown panel is dark brown. Each icon was separated by colour distance from the local panel colour, with alpha 15→45, then placed on the history row's tan (224,197,157) using `pixel + (1−α)(tan − panel)`.
- **Framed by the larger dimension.** Both icons are taller than wide (23×27 and 21×28 in the dropdown), at the 0.92 fill used by the rest of the family. The matcher treats a contour taller than 1.1× its width as a vertical merge and sizes crops from the width, and its sweep (width −4 … +16) reaches a frame that holds the whole icon.
- **The method was validated on known icons first.** The same pipeline was run on the 17 known icons in the same screenshots and scored against the shipped templates: all 17 resolved to the right resource, with a mean margin of 0.32.
- **No theft of existing rows.** Replaying the 2,754-row local corpus (`scripts/diagnose-resource-icons.mjs data/resource_test_screenshots`), neither new template won a row or reached any row's top three.

What that cannot prove is how well they match **real SK history rows**, because none existed yet. After the SK clan's first resource reads, check its Forest Essence / Magic Seeds rows. If they land unresolved or with thin margins, cut `-2` variants from the unresolved-row evidence crops with [extract-icon-from-row-crop.mjs](../scripts/extract-icon-from-row-crop.mjs). That is additive and can only raise these two resources; see [resource-capture.md](resource-capture.md).

`tGame()` has no official es/fr/ru/de names for them yet, so they display in English (docs/i18n.md: a guessed name is worse than English).
