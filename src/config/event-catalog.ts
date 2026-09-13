/**
 * Event catalog — the chest → in-game-event mapping.
 *
 * This is the single source of truth for the Events page. Each event lists a
 * set of match rules; a chest record matches an event when it satisfies ANY
 * rule, and a rule matches when ALL of its set fields match (OR-of-ANDs). This
 * lets an event be identified by exact chest name, by a substring of the
 * chest's source string, or by both — the last is needed for generic chests
 * (e.g. "Sapphire Chest") that only count toward an event when they come from
 * a specific source ("Vault of the Ancients").
 *
 * Adding a new event, or a new chest to an existing event, is just a matter of
 * appending here — no other code changes. A rule referencing a chest that has
 * never been scanned resolves to nothing and is silently skipped, so it's safe
 * to pre-declare chests before they show up in the data.
 *
 * chestName values must match `chests.name` — the spelling the DB actually
 * holds, which is whatever `correctChestName` produces (see KNOWN_CHESTS in
 * src/vision/chest-names.ts). Getting that wrong is silent: the rule resolves
 * to no chest ids and its column renders a permanent 0 that looks exactly like
 * "nobody did the event". Two things stop that now — tests/config/event-catalog.test.ts
 * fails the build if any name here disagrees with correctChestName, and
 * resolvePredicate in src/data/repositories/event-repo.ts folds a stale spelling
 * onto the live chest anyway and warns instead of silently dropping the rule.
 */

export interface EventMatchRule {
  /** Exact chest name (matches chests.name). */
  chestName?: string;
  /**
   * Several exact chest names that all feed a SINGLE matrix column — use this
   * (with an explicit `label`) to collapse related chests into one column when
   * the table gets too wide (e.g. Dark Omens' Minor/Major/Epic summon chests).
   * Combines with `chestName` (both contribute to the same column). The
   * per-member drill-down still lists each chest separately.
   */
  chestNames?: string[];
  /** Case-insensitive substring of chest_sources.source. */
  sourceContains?: string;
  /** Column label for the per-player matrix (defaults to chestName). */
  label?: string;
  /**
   * Whether this column feeds the per-player "Total" column (and the
   * Avg/Participant summary). Defaults to true. Set false for columns that
   * are shown for context but aren't "participation" — e.g. Ancients' Vault
   * and Golden Guardian columns, where Total should reflect only the event
   * reward chests (Ancients' + Quick March).
   */
  countInTotal?: boolean;
  /**
   * Render this rule as a top-of-page "info card" (a small summary box)
   * instead of a per-player matrix column. Use for chests that only one or a
   * few members ever receive — e.g. Dark Omens' end-of-event "ranking" chest,
   * which goes to the clan leader — where a whole column would be noise.
   * Implies not counting toward Total/Points regardless of countInTotal.
   */
  infoCard?: boolean;
  /**
   * This chest is the CLAN's reward, not the recipient's own play: the game
   * hands a whole clan's end-of-event placement prize to one account in a
   * single bulk drop — 1006 Olympus Elite Chests to one member inside 59
   * seconds on the 2026-08-24 run. Nobody farmed them.
   *
   * Every surface that RANKS members, or names a member's best day, therefore
   * leaves them out (see src/data/clan-reward-chests.ts for the list and the
   * resolver). Clan-level totals keep counting them — the clan really does
   * hold them — which is the same split the Events page already draws between
   * its per-player Total and its grand total.
   *
   * Deliberately NOT the same flag as `infoCard`, whose criterion is how MANY
   * members receive a chest — a layout choice. A rare but genuinely EARNED
   * chest, flagged infoCard purely to keep the table narrow, must not silently
   * vanish from its earner's analytics.
   */
  clanReward?: boolean;
}

/**
 * One column of a bucketed level event — an INCLUSIVE level range. See
 * `levelBuckets`.
 */
export interface EventLevelBucket {
  from: number;
  to: number;
}

export interface EventDefinition {
  /** URL-safe key used in the hash route (#events/<key>) and API path. */
  key: string;
  /** Display name shown on the sub-tab and page header. */
  name: string;
  /** Sub-tab ordering (ascending). */
  order: number;
  /** Blurb shown under the event title. */
  description: string;
  /**
   * How the per-player matrix is broken out:
   *  - 'chest': one column per rule (e.g. Ancients: Vault / Golden Guardian / …)
   *  - 'level': one column per distinct source level present (e.g. Citadels)
   */
  columnMode: 'chest' | 'level';
  /**
   * Level mode only. Collapses the per-level columns into a FIXED set of
   * inclusive level ranges — one column per bucket instead of one per
   * (chest type × level) — with the per-level split kept as a hover tooltip.
   *
   * Use it when the source levels are too many or too sparse to be columns of
   * their own: Heroics spans levels 16-45, which would be thirty columns, most
   * of them empty in any one week.
   *
   * Three behaviours differ from plain level mode, all deliberate:
   *  - Columns are the DECLARED buckets, always all of them, present in the
   *    data or not. Plain level mode derives its columns from the data, which
   *    makes them shift between timeframes; a fixed tier list shouldn't.
   *  - The chest type is NOT part of the column key, so a rule may match on
   *    `sourceContains` alone (Heroics: five monster chests × six tiers, all of
   *    which are just "a heroic kill at level n").
   *  - A level that falls outside every bucket still gets its OWN column rather
   *    than being dropped, because the game raising its level cap must not read
   *    as nobody playing. Same reasoning as the config-error surfacing.
   *
   * Ranges must be ascending and non-overlapping — pinned by
   * tests/config/event-catalog.test.ts.
   */
  levelBuckets?: EventLevelBucket[];
  /** Show an extra level-distribution card above the table (vaults). */
  showLevelCard: boolean;
  /**
   * When set, a lead summary stat card with this label shows the total
   * number of leveled (vault) chests — i.e. "vaults taken down" for Ancients.
   */
  levelSummaryLabel?: string;
  /**
   * Fixed-length rolling cycle, for an event that recurs forever on its own
   * clock and therefore has no entry in the calendar feed: the window is
   * `days` long, restarts the instant it ends, and every boundary falls on the
   * game-day reset (17:00 UTC). `anchor` is any ONE known cycle start — the
   * schedule is periodic, so boundaries are just multiples of the length away
   * from it in both directions.
   *
   * Like calendarNames this drives the Events page's per-occurrence timeframe
   * selector (one cycle = one selectable window); unlike it, nothing is ever
   * "upcoming" or "live", so the tab shows a countdown to the next reset. Set
   * one or the other, never both.
   */
  cycle?: { anchor: string; days: number };
  /**
   * Row-header label for the "By level" card (only meaningful when
   * showLevelCard is true). Defaults to "Vault" (Ancients). Set to describe
   * what each level row is for other level events — e.g. "Raid" for Runics.
   */
  levelCardLabel?: string;
  /**
   * In-game event name(s) exactly as they appear in the tbclanportal calendar
   * feed's VEVENT SUMMARY (minus the leading emoji and any "(Day x/y)" / variant
   * suffix). Matching is diacritic- and case-insensitive and by prefix, so
   * "Trials of Olympus - Chimera (Day 1/5)" still resolves to "Trials of Olympus".
   *
   * When set, the Events page timeframe selector shows per-occurrence buckets
   * sourced from the feed (one event run = one window) instead of the fixed
   * Weekly/Monthly selector — see src/external/event-calendar.ts. Several names
   * merge into one occurrence stream: Ancients pairs "Ancients' Treasure"
   * (day 1) with the back-to-back "Rise of the Ancients" (day 2), which the
   * contiguity grouping fuses into the real 2-day event.
   *
   * Omit for events with no feed entry: Triumphal runs on its own rolling
   * 30-day clock (see `cycle`), and Citadels and Heroics are 24/7 ongoing, so
   * they keep the fixed Weekly/Monthly selector.
   */
  calendarNames?: string[];
  rules: EventMatchRule[];
}

export const EVENT_CATALOG: EventDefinition[] = [
  {
    key: 'ancients',
    name: 'Ancients',
    order: 1,
    description:
      'Rise of the Ancients — Vault of the Ancients kills plus the Tinman event rewards.',
    columnMode: 'chest',
    showLevelCard: true,
    levelSummaryLabel: 'Vaults Taken Down',
    // Two feed events, one in-game cycle: "Ancients' Treasure" (day 1) runs
    // back-to-back with "Rise of the Ancients" (day 2), which contiguity
    // grouping fuses into the single 2-day Ancients occurrence.
    calendarNames: ['Rise of the Ancients', "Ancients' Treasure"],
    rules: [
      // Sapphire only counts here when it dropped from a Vault of the Ancients.
      // Vault + Golden Guardian are shown for context but don't feed the
      // participation Total (that's the Rise-of-the-Ancients reward chests).
      { chestName: 'Sapphire Chest', sourceContains: 'vault of the ancients', label: 'Vault', countInTotal: false },
      // Epic, Legendary AND Ascendant — all three drop from the same "Epic
      // Ancient squad" source, and the game adds a tier each time the monster
      // level goes up (Ascendant arrived that way, already 382 chests deep by
      // the time it was noticed). Naming only the Epic one quietly dropped 179
      // Legendary chests from the page: not a rename casualty, but it failed
      // exactly as silently. A new tier belongs in THIS array — one column per
      // reward, not one per tier, since the tiers are the same reward scaling.
      {
        chestNames: [
          'Golden Guardian Epic Chest',
          'Golden Guardian Legendary Chest',
          'Golden Guardian Ascendant Chest',
        ],
        label: 'Golden Guardian',
        countInTotal: false,
      },
      { chestName: "Ancients' Chest", label: "Ancients'" },
      { chestName: 'Quick March Chest', label: 'Quick March' },
    ],
  },
  {
    key: 'ragnarok',
    name: 'Ragnarok',
    order: 2,
    description: 'Ragnarok — Jormungandr rewards.',
    columnMode: 'chest',
    showLevelCard: false,
    calendarNames: ['Ragnarök'],
    rules: [
      // Jörmungandr's Chest covers both the Jörmungandr Shop and the Epic
      // Jörmungandr squad kill (same chest name, different sources). Spell it
      // with the umlaut — that is what `chests.name` holds; see the test in
      // tests/config/event-catalog.test.ts, which pins every name here against
      // correctChestName so the next rename cannot strand this rule again.
      { chestName: "Jörmungandr's Chest", label: 'Jormungandr' },
      { chestName: "Fenrir's Chest", label: 'Fenrir' },
    ],
  },
  {
    key: 'olympus',
    name: 'Olympus',
    order: 3,
    description: 'Trials of Olympus — Tartaros crypt, clan placement, and Hermes’ store.',
    columnMode: 'chest',
    showLevelCard: false,
    // Five contiguous "Day x/5" VEVENTs → one 5-day occurrence.
    calendarNames: ['Trials of Olympus'],
    rules: [
      { chestName: 'Tartaros Chest', label: 'Tartaros' },
      // Clan placement reward handed to the leader at the end of the run — the
      // Olympus equivalent of Dark Omens' ranking chest, so surface it as a
      // top-of-page Finish Reward card, not a mostly-empty per-player column.
      //
      // Two names, ONE reward: the game awards the plain chest or the Elite one
      // according to the clan's level, never both, so they feed the same card.
      // Splitting them into two cards would leave whichever tier the clan
      // doesn't qualify for permanently reading "Not awarded". Seen on the
      // 2026-08-24 run, where clan 1 took 1006 Elite and clan 2 took 300 plain
      // in the same closing-day slot, neither clan receiving the other's.
      {
        chestNames: ['Olympus Chest', 'Olympus Elite Chest'],
        label: 'Finish Reward',
        infoCard: true,
        clanReward: true,
      },
      { chestName: 'Hermes Chest', label: 'Hermes (shop)' },
      { chestName: 'Basilisk Chest', label: 'Basilisk' },
      { chestName: 'Chimera Chest', label: 'Chimera' },
      { chestName: 'Briareus Chest', label: 'Briareus' },
    ],
  },
  {
    key: 'dark-omens',
    name: 'Dark Omens',
    order: 4,
    description: 'Dark Omens — summoning chests, event rewards, and ranking rewards.',
    columnMode: 'chest',
    showLevelCard: false,
    calendarNames: ['Dark Omens'],
    rules: [
      // Minor/Major/Epic summon chests share one column to keep the (now
      // wider) table readable; the drill-down still breaks them out.
      { chestNames: ['Minor Omen Chest', 'Major Omen Chest', 'Epic Omen Chest'], label: 'Omens (M/M/E)' },
      { chestName: 'Arcane Chest', label: 'Arcane' },
      { chestName: 'Spoils of Dread Chest', label: 'Spoils of Dread' },
      { chestName: 'Dark Omens chest', label: 'Dark Omens' },
      // Clan-leader end-of-event reward — one recipient, so surface it as a
      // top-of-page info card rather than a mostly-empty per-player column.
      {
        chestName: 'Dark Omens ranking chest',
        label: 'Finish Reward',
        infoCard: true,
        clanReward: true,
      },
    ],
  },
  {
    key: 'triumphal',
    name: 'Triumphal',
    order: 5,
    description:
      'Union Chest — Gold Pass rewards and store purchases, in rolling 30-day cycles.',
    columnMode: 'chest',
    showLevelCard: false,
    // Not in the calendar feed: Triumphal runs a rolling 30-day track that is
    // NOT aligned to the calendar month — it restarts at the game-day reset the
    // moment one cycle ends, so the day-of-month drifts. Anchor read off the
    // in-game timer on 2026-07-28 ("26d 6h left" of 30 days ⇒ the cycle opened
    // at the 2026-07-24 17:00 UTC reset); every other boundary is a multiple of
    // 30 days from there.
    cycle: { anchor: '2026-07-24T17:00:00.000Z', days: 30 },
    // NB: the Union Chest lives in the normal chest_records table and is
    // unrelated to the separate "Triumphal Chests" tab (triumphal_chest_records).
    rules: [{ chestName: 'Union Chest', label: 'Union' }],
  },
  {
    key: 'citadels',
    name: 'Citadels',
    order: 6,
    description: 'Citadel participation, broken down by citadel level (Elven + Cursed).',
    columnMode: 'level',
    showLevelCard: false,
    rules: [
      // In level mode the label is the citadel-type prefix; columns become
      // "<label> Lvl <n>" (e.g. "Elven Lvl 25", "Cursed Lvl 25") so the two
      // citadel types stay separate per level.
      { chestName: 'Elven Citadel Chest', label: 'Elven' },
      { chestName: 'Cursed Citadel Chest', label: 'Cursed' },
    ],
  },
  {
    key: 'runics',
    name: 'Runics',
    order: 7,
    description: 'Runic Chests gathered by members raiding runic squads, broken down by level.',
    // One chest ("Runic Chest") that drops at several raid tiers. Level mode
    // gives each tier its own per-player column (Lvl 20-24/25-29/…), and the
    // level card echoes the Ancients-vault "By level" breakdown.
    //
    // No levelSummaryLabel: unlike Ancients (where leveled vault kills are a
    // subset of total chests), every Runic chest is leveled, so a "Runic
    // Chests" lead card would just duplicate "Total Chests".
    columnMode: 'level',
    showLevelCard: true,
    levelCardLabel: 'Raid',
    // Runic chests are the reward track of the "Pursuit of Experience" event.
    calendarNames: ['Pursuit of Experience'],
    rules: [{ chestName: 'Runic Chest', label: 'Runic' }],
  },
  {
    key: 'heroics',
    name: 'Heroics',
    order: 8,
    description: 'Heroic Monster kills, grouped by monster level tier (16-45).',
    // Matched on the SOURCE only, with no chest name at all — and that is the
    // whole point of the rule. The game drops five different chests off heroic
    // monsters on a repeating five-level cycle (Undead 16, Elven 17, Cursed 18,
    // Barbarian 19, Inferno 20, then again from 21), and one of them —
    // Barbarian Chest — is overwhelmingly a CRYPT chest: 11k crypt records
    // against 114 heroic ones in the Aug 2026 data. A chestNames rule would
    // therefore have to be paired with this same sourceContains anyway, and
    // would additionally go silent the day the game adds a sixth monster.
    // Matching the source alone counts every heroic kill by construction.
    //
    // "heroic monster" and not merely "heroic": every one of the 19 source
    // spellings in production is "Level <n> heroic Monster" (lowercase h — the
    // game's own casing; sourcesMatching folds case on both sides), so the
    // longer needle costs nothing and can't collide with a future source that
    // just happens to contain the word.
    columnMode: 'level',
    // Thirty levels is thirty columns, and in any one week most are empty. The
    // buckets below are not a display convenience — they are the game's real
    // tiers, confirmed by its own scoring: stored point_value is flat within
    // each range and steps at every boundary (16-19 → 20, 20-24 → 60,
    // 25-29 → 150, 30-34 → 350, 35-39 → 625). 16-19 and 45 are short because
    // heroic monsters start at 16 and stop at 45, not because they're partial.
    levelBuckets: [
      { from: 16, to: 19 },
      { from: 20, to: 24 },
      { from: 25, to: 29 },
      { from: 30, to: 34 },
      { from: 35, to: 39 },
      { from: 40, to: 44 },
      { from: 45, to: 45 },
    ],
    // Matches Citadels: heroic monsters are on the map 24/7, so there is no
    // occurrence to select and no "By level" card on top of the buckets.
    showLevelCard: false,
    rules: [{ sourceContains: 'heroic monster', label: 'Heroic' }],
  },
];

export function getEventDef(key: string): EventDefinition | undefined {
  return EVENT_CATALOG.find((e) => e.key === key);
}

/** Catalog trimmed to what the sub-tab bar needs, ordered. */
export function getEventCatalogSummary(): Array<{
  key: string;
  name: string;
  order: number;
  description: string;
}> {
  return [...EVENT_CATALOG]
    .sort((a, b) => a.order - b.order)
    .map(({ key, name, order, description }) => ({ key, name, order, description }));
}
