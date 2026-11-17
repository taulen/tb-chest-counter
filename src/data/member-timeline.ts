/**
 * A member's history as one timeline (profile → Timeline): everything the
 * game and the site recorded about them, newest first, as entries a page can
 * draw without knowing where each came from.
 *
 * Built from rows other features already keep (see member-timeline-repo.ts);
 * nothing here is invented. The rule every source follows: the FIRST read of a
 * source is the baseline — when we started looking, not when the player got
 * there — so it is never shown as a change (the change readers already drop it
 * for research, captains, artifacts and equipment; player history, city
 * status and the dragon drop their first row here).
 *
 * A day's many small changes of one kind fold into one entry with items
 * (research, talents, captains, gear, titles), and so does a run of
 * screenshot-era merges; everything else is one entry each.
 * Pure: the repo gathers the rows, the route adds the URLs it needs.
 */
import { gameDateFor } from '../utils/game-day.js';
import type { RosterChange } from './roster-changes.js';

export type TimelineKind =
  | 'joined' | 'left' | 'renamed' | 'merged' | 'rank'
  | 'hero_level' | 'city_level' | 'vip' | 'gold_pass' | 'hero' | 'might' | 'tier' | 'dragon'
  | 'titles'
  | 'research' | 'talents' | 'captains' | 'artifact' | 'gear'
  | 'shield' | 'burning';

/** The filter chips: what kind of news an entry is. */
export type TimelineGroup = 'clan' | 'growth' | 'titles' | 'research' | 'captains' | 'city';

export const TIMELINE_GROUPS: Record<TimelineKind, TimelineGroup> = {
  joined: 'clan', left: 'clan', renamed: 'clan', merged: 'clan', rank: 'clan',
  hero_level: 'growth', city_level: 'growth', vip: 'growth', gold_pass: 'growth', hero: 'growth', might: 'growth', tier: 'growth',
  dragon: 'growth',
  titles: 'titles',
  research: 'research', talents: 'research',
  captains: 'captains', artifact: 'captains', gear: 'captains',
  shield: 'city', burning: 'city',
};

/**
 * Names a merged-in spelling is checked against: every name the game reported
 * for a player (game_players, game_player_history — any clan) and every name a
 * person typed in a manual rename (rename_member audit rows without a source).
 */
export interface KnownNames {
  gameNames: ReadonlySet<string>;
  typedNames: ReadonlySet<string>;
}

/**
 * A name merged into a member is a **screenshot-era spelling** when the game
 * never reported it for any player and no person typed it: before Nov 17 2026
 * names came from the screenshot reader (OCR) or from an admin, so a name that
 * is neither the game's nor an admin's can only be the reader's — most often a
 * misreading ("lg 5 5S pw", "FENROTH Of CHAOS", "Mκam from Chaos"), sometimes a
 * player's old name as the reader saw it. A merge of the game's own spelling
 * ("Нимдуен" into "Nimduen") or of a name an admin typed is a real merge.
 * Exact strings: "Feli" is not "FELI".
 */
export function isScreenshotSpelling(name: string, known: KnownNames): boolean {
  return name !== '' && !known.gameNames.has(name) && !known.typedNames.has(name);
}

/** A title as the static data has it (route: names.json `titles` + art). */
export interface TimelineTitleInfo {
  /** The game's English name (the page shows it through tGame); `#id` when unknown. */
  name: string;
  /** How long it lasts from when it was received; 0 = no set end (or unknown). */
  seconds: number;
  /** "Can be obtained by activating Premium."; '' when the game names none. */
  source: string;
  iconUrl: string | null;
}

/**
 * A first read without a timed title at most this long before its computed end
 * is our clock against the game's: it ran out, it was not taken.
 */
const TITLE_END_SKEW_MS = 5 * 60_000;

export interface TimelineEntry {
  /** Unique and stable across requests: the paging cursor's tie-break. */
  key: string;
  kind: TimelineKind;
  group: TimelineGroup;
  /** When (ISO): the read that saw it; a folded entry's latest read. */
  at: string;
  /** The game day it belongs to (rollover-aware). */
  day: string;
  [field: string]: unknown;
}

/** A day-over-day might move at least this big (either way) is news. */
export const MIGHT_MOVE_RATIO = 0.1;

export interface PlayerHistoryRow {
  at: string; name: string; heroLevel: number | null; cityLevel: number | null; vip: number | null;
  goldPass: number | null; heroAvatar: number | null; role: number | null;
}

export interface TimelineSources {
  /**
   * The member's joins, returns, restores and leaves, as My Clan → Joins &
   * leaves derives them (roster-changes.ts) — one rule set for both views.
   */
  moves: RosterChange[];
  /** game_player_history, oldest first (the first row is the baseline). */
  playerHistory: PlayerHistoryRow[];
  /**
   * Site actions about this member (manual renames, merges into it). A merge's
   * `screenshotSpelling` says its merged-in name is a screenshot-era spelling
   * (isScreenshotSpelling, decided by the repo against the stored names).
   */
  audit: Array<{ at: string; action: string; details: Record<string, unknown>; screenshotSpelling?: boolean }>;
  /**
   * The player's title grants (game_player_titles, v125), any order:
   * `assignedAt` is the game's own time (unix s); `firstSeen` / `goneAt` the
   * first read with it and the first read without it.
   */
  titles: Array<{ titleId: number; assignedAt: number; firstSeen: string; goneAt: string | null }>;
  /** Research / talent level changes, baseline already left out. */
  techChanges: Array<{ at: string; techId: number; level: number; prevLevel: number | null }>;
  /** Troop tier changes after the first read (member-tiers.ts). */
  tierChanges: Array<{ at: string; family: string; from: number | null; to: number }>;
  captainChanges: Array<{ changedAt: string; captainId: number; level: number; stars: number; prevLevel: number | null; prevStars: number | null }>;
  artifactChanges: Array<{ changedAt: string; artifactType: number; level: number; star: number; prevLevel: number | null; prevStar: number | null; rerolled: boolean }>;
  equipmentChanges: Array<{ changedAt: string; captainId: number; position: number; itemType: number; prevType: number | null; reworked: boolean }>;
  /** game_city_status_history, oldest first (the first row is the baseline). */
  cityStatus: Array<{ at: string; shielded: number; burning: number }>;
  /** The member's daily might (member_snapshots), oldest first. */
  mightDays: Array<{ day: string; at: string; might: number }>;
  /**
   * The dragon (city field 26) of each daily city snapshot, oldest first; the
   * first with a level is the baseline. `stage` is null on reads from before
   * it was parsed.
   */
  dragonDays: Array<{ day: string; at: string; level: number | null; stage: number | null }>;
}

/** Names and pictures, resolved by the caller (game data and art are the route's business). */
export interface TimelineLookups {
  techName(id: number): string;
  techIconUrl(id: number): string | null;
  /** research | talent (hero talents) — anything else counts as research. */
  techKind(id: number): 'research' | 'talent';
  captainName(id: number): string;
  captainIconUrl(id: number): string | null;
  artifactName(type: number): string;
  artifactIconUrl(type: number): string | null;
  itemName(type: number): string;
  itemIconUrl(type: number): string | null;
  heroName(avatarId: number): string;
  heroAvatarUrl(avatarId: number): string | null;
  /** The dragon's icon at an evolution stage (T73), null when unknown or not extracted. */
  dragonIconUrl(stage: number | null): string | null;
  /** A title (T29) by id. */
  title(id: number): TimelineTitleInfo;
}

const ms = (iso: string) => Date.parse(iso);

/**
 * Every entry for one member, newest first (ties: by key, so paging is stable).
 * `nowMs` decides which titles have run out.
 */
export function buildTimeline(src: TimelineSources, look: TimelineLookups, rolloverUtcHour: number, nowMs: number = Date.now()): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const dayOf = (iso: string) => gameDateFor(ms(iso), rolloverUtcHour);
  const add = (kind: TimelineKind, at: string, id: string, fields: Record<string, unknown> = {}) => {
    out.push({ key: `${kind}:${id}`, kind, group: TIMELINE_GROUPS[kind], at, day: dayOf(at), ...fields });
  };
  /** A game day's rows of one kind as one entry with items, dated by its latest row. */
  const fold = <T>(kind: TimelineKind, rows: Array<{ at: string; item: T }>) => {
    const byDay = new Map<string, { at: string; items: T[] }>();
    for (const r of rows) {
      const day = dayOf(r.at);
      const g = byDay.get(day);
      if (g) {
        g.items.push(r.item);
        if (ms(r.at) > ms(g.at)) g.at = r.at;
      } else {
        byDay.set(day, { at: r.at, items: [r.item] });
      }
    }
    for (const [day, g] of byDay) add(kind, g.at, day, { items: g.items });
  };

  // ── The clan: joins and leaves the way My Clan → Joins & leaves has them ──
  for (const m of src.moves) {
    const fields = { asName: m.asName };
    if (m.kind === 'left') add('left', m.at, m.key, { ...fields, site: m.source === 'site' });
    else if (m.kind === 'restored') add('joined', m.at, m.key, { ...fields, restored: true });
    else add('joined', m.at, m.key, { ...fields, returned: m.kind === 'returned', prevLeftAt: m.prevLeftAt, seenSince: m.seenSince });
  }
  // A merge of a screenshot-era spelling is the site tidying up what the old
  // screenshot reader saw, not news about the player: tagged `ocr`, and folded
  // with its neighbours at the end (foldScreenshotRuns).
  for (const a of src.audit) {
    const d = a.details;
    if (a.action === 'rename_member' && !d.source && typeof d.newName === 'string') {
      add('renamed', a.at, `admin:${a.at}`, { by: 'admin', from: typeof d.from === 'string' ? d.from : null, to: d.newName });
    } else if (a.action === 'merge_player' && typeof d.from === 'string') {
      add('merged', a.at, `${a.at}:${d.from}`, { from: d.from, ocr: a.screenshotSpelling === true });
    }
  }

  // ── The player record (402), first row = baseline ──
  for (let i = 1; i < src.playerHistory.length; i++) {
    const p = src.playerHistory[i - 1];
    const n = src.playerHistory[i];
    const at = n.at;
    if (n.name !== p.name) add('renamed', at, `game:${at}`, { by: 'game', from: p.name, to: n.name });
    if (n.role !== null && p.role !== null && n.role !== p.role) {
      // 1 = leader … 5: a smaller number is a higher rank.
      add('rank', at, at, { from: p.role, to: n.role, promoted: n.role < p.role });
    }
    if (n.heroLevel !== null && p.heroLevel !== null && n.heroLevel !== p.heroLevel) add('hero_level', at, at, { from: p.heroLevel, to: n.heroLevel });
    if (n.cityLevel !== null && p.cityLevel !== null && n.cityLevel !== p.cityLevel) add('city_level', at, at, { from: p.cityLevel, to: n.cityLevel });
    if (n.vip !== null && p.vip !== null && n.vip !== p.vip) add('vip', at, at, { from: p.vip, to: n.vip });
    if (n.goldPass !== null && p.goldPass !== null && n.goldPass !== p.goldPass) add('gold_pass', at, at, { on: n.goldPass === 1 });
    if (n.heroAvatar !== null && p.heroAvatar !== null && n.heroAvatar !== p.heroAvatar) {
      add('hero', at, at, { name: look.heroName(n.heroAvatar), avatarUrl: look.heroAvatarUrl(n.heroAvatar) });
    }
  }

  // ── Might: only the big daily moves ──
  for (let i = 1; i < src.mightDays.length; i++) {
    const p = src.mightDays[i - 1];
    const n = src.mightDays[i];
    if (p.might > 0 && Math.abs(n.might - p.might) / p.might >= MIGHT_MOVE_RATIO) {
      add('might', n.at, n.day, { from: p.might, to: n.might });
    }
  }

  // ── Troop tiers ──
  for (const t of src.tierChanges) add('tier', t.at, `${t.family}:${t.at}`, { family: t.family, from: t.from, to: t.to });

  // ── The dragon: a level or an evolution moved since the last day read ──
  // Compared with the last day that had a value: a day with no dragon read
  // ({} in the snapshot) is a gap, not a drop. A stage first seen (reads from
  // before it was parsed have none) is the stage's baseline.
  let lastLevel: number | null = null;
  let lastStage: number | null = null;
  for (const d of src.dragonDays) {
    if (d.level === null) continue;
    const levelMoved = lastLevel !== null && d.level !== lastLevel;
    const stageMoved = lastStage !== null && d.stage !== null && d.stage !== lastStage;
    if (levelMoved || stageMoved) {
      add('dragon', d.at, d.day, {
        ...(levelMoved ? { from: lastLevel, to: d.level } : {}),
        ...(stageMoved ? { stageFrom: lastStage, stageTo: d.stage } : {}),
        iconUrl: look.dragonIconUrl(d.stage ?? lastStage),
      });
    }
    lastLevel = d.level;
    if (d.stage !== null) lastStage = d.stage;
  }

  // ── Titles: received, and how each ended; one entry per game day ──
  fold('titles', titleChanges(src.titles, look, nowMs));

  // ── Research and talents: one entry per game day and kind ──
  const techItem = (c: TimelineSources['techChanges'][number]) => ({
    techId: c.techId, name: look.techName(c.techId), iconUrl: look.techIconUrl(c.techId), level: c.level, prevLevel: c.prevLevel,
  });
  fold('research', src.techChanges.filter((c) => look.techKind(c.techId) === 'research').map((c) => ({ at: c.at, item: techItem(c) })));
  fold('talents', src.techChanges.filter((c) => look.techKind(c.techId) === 'talent').map((c) => ({ at: c.at, item: techItem(c) })));

  // ── Captains, artifacts, gear ──
  fold('captains', src.captainChanges.map((c) => ({
    at: c.changedAt,
    item: {
      captainId: c.captainId, name: look.captainName(c.captainId), iconUrl: look.captainIconUrl(c.captainId),
      level: c.level, prevLevel: c.prevLevel, stars: c.stars, prevStars: c.prevStars,
    },
  })));
  for (const a of src.artifactChanges) {
    add('artifact', a.changedAt, `${a.artifactType}:${a.changedAt}`, {
      artifactType: a.artifactType, name: look.artifactName(a.artifactType), iconUrl: look.artifactIconUrl(a.artifactType),
      level: a.level, prevLevel: a.prevLevel, star: a.star, prevStar: a.prevStar, rerolled: a.rerolled,
      // We only ever see the artifacts the three line-up captains wear: one seen
      // for the first time moved INTO the line-up, it is not new to the player.
      intoLineup: a.prevLevel === null,
    });
  }
  fold('gear', src.equipmentChanges.map((e) => ({
    at: e.changedAt,
    item: {
      captainId: e.captainId,
      captainName: e.captainId === 1 ? null : look.captainName(e.captainId),
      position: e.position,
      change: e.itemType === 0 ? 'taken_off' : e.reworked ? 'reworked' : 'put_on',
      name: e.itemType ? look.itemName(e.itemType) : null,
      iconUrl: e.itemType ? look.itemIconUrl(e.itemType) : null,
      prevName: e.prevType ? look.itemName(e.prevType) : null,
      prevIconUrl: e.prevType ? look.itemIconUrl(e.prevType) : null,
    },
  })));

  // ── The city on the map, first row = baseline ──
  for (let i = 1; i < src.cityStatus.length; i++) {
    const p = src.cityStatus[i - 1];
    const n = src.cityStatus[i];
    if (n.shielded !== p.shielded) add('shield', n.at, n.at, { on: n.shielded === 1 });
    if (n.burning !== p.burning) add('burning', n.at, n.at, { on: n.burning === 1 });
  }

  return foldScreenshotRuns(out.sort(byNewest));
}

/** A spelling in a folded run of screenshot-era merges: every time it was merged in, oldest first. */
export interface ScreenshotSpellingItem {
  name: string;
  ats: string[];
}

/**
 * Screenshot-era merges with nothing else on the Timeline between them fold
 * into one entry: the OCR era merged the same misreading again and again
 * (one member's "FENROTH Of CHAOS" variants: 18 merges from July to August
 * 2026; "أوزيريس": 43), and a line each read like that many events. The entry is dated by the run's
 * newest merge and lists each spelling once with all its merge times; one
 * spelling merged once stays a single line. Input and output newest first.
 */
function foldScreenshotRuns(sorted: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let run: TimelineEntry[] = [];
  const flush = () => {
    if (!run.length) return;
    const newest = run[0];
    const oldest = run[run.length - 1];
    const spellings = new Map<string, string[]>();
    for (let i = run.length - 1; i >= 0; i--) {
      const from = String(run[i].from);
      const ats = spellings.get(from);
      if (ats) ats.push(run[i].at);
      else spellings.set(from, [run[i].at]);
    }
    const items: ScreenshotSpellingItem[] = [...spellings].map(([name, ats]) => ({ name, ats }));
    out.push({
      key: `merged:ocr:${oldest.at}`, kind: 'merged', group: TIMELINE_GROUPS.merged,
      at: newest.at, day: newest.day, ocr: true, items,
    });
    run = [];
  };
  for (const e of sorted) {
    if (e.kind === 'merged' && e.ocr === true) run.push(e);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

/** One line of a day's titles entry. */
export interface TitleChange {
  titleId: number;
  name: string;
  iconUrl: string | null;
  /**
   * received — the game's own time it was received; again — received anew
   * while the last one still ran (a timed title won again: its clock restarts);
   * ran_out — its set time ended; gone — the first read without it (no set
   * end, or taken before its end).
   */
  change: 'received' | 'again' | 'ran_out' | 'gone';
  at: string;
}

type Grant = TimelineSources['titles'][number];

/**
 * What the Timeline says about a player's titles, oldest first. Grants (one
 * row each time the game assigned a title) become holdings:
 *
 * - A title with a set end (Prefect 7 days, tournament titles 7–30): received
 *   at its `assignedAt`; a grant received before the last one's end is
 *   "received again" (no end in between); the end is `assignedAt + seconds`
 *   once passed ("ran out" — the server drops it then), or the first read
 *   without it when that came earlier ("gone": taken). Still running: no end.
 * - A title with no set end (Premium's three, palace titles): the game
 *   re-grants these every few hours with a new `assignedAt`, and Premium's
 *   three take turns, so they count by READS: titles sharing a source
 *   ("…activating Premium.") are one holding while every read saw one of them
 *   (or the next was assigned before the last went). Received = the holding's
 *   first grant; gone = the first read with none of them, named by the title
 *   held last. Held at the latest read (or not read since): no end.
 */
export function titleChanges(
  grants: TimelineSources['titles'], look: Pick<TimelineLookups, 'title'>, nowMs: number,
): Array<{ at: string; item: TitleChange }> {
  const out: Array<{ at: string; item: TitleChange }> = [];
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const push = (g: Grant, change: TitleChange['change'], at: string) => {
    const t = look.title(g.titleId);
    out.push({ at, item: { titleId: g.titleId, name: t.name, iconUrl: t.iconUrl, change, at } });
  };

  // Timed titles hold by title; untimed ones by source (or by title without one).
  const families = new Map<string, { seconds: number; grants: Grant[] }>();
  for (const g of grants) {
    const t = look.title(g.titleId);
    const key = t.seconds > 0 ? `id:${g.titleId}` : t.source ? `source:${t.source}` : `id:${g.titleId}`;
    const f = families.get(key);
    if (f) f.grants.push(g);
    else families.set(key, { seconds: Math.max(0, t.seconds), grants: [g] });
  }

  for (const { seconds, grants: list } of families.values()) {
    if (seconds > 0) {
      const ended = (g: Grant) => {
        const endMs = (g.assignedAt + seconds) * 1000;
        if (g.goneAt && ms(g.goneAt) < endMs - TITLE_END_SKEW_MS) push(g, 'gone', g.goneAt);
        else if (endMs <= nowMs) push(g, 'ran_out', new Date(endMs).toISOString());
      };
      list.sort((a, b) => a.assignedAt - b.assignedAt);
      let prev: Grant | null = null;
      for (const g of list) {
        if (prev && g.assignedAt < prev.assignedAt + seconds) {
          push(g, 'again', iso(g.assignedAt));
        } else {
          if (prev) ended(prev);
          push(g, 'received', iso(g.assignedAt));
        }
        prev = g;
      }
      if (prev) ended(prev);
      continue;
    }

    list.sort((a, b) => ms(a.firstSeen) - ms(b.firstSeen) || a.assignedAt - b.assignedAt);
    // `until` = the first read without any of the holding's titles; null = held.
    let hold: { last: Grant; until: string | null } | null = null;
    const close = () => { if (hold?.until) push(hold.last, 'gone', hold.until); };
    for (const g of list) {
      const continues = hold !== null
        && (hold.until === null || ms(g.firstSeen) <= ms(hold.until) || g.assignedAt * 1000 <= ms(hold.until));
      if (hold && continues) {
        if (g.goneAt === null) hold = { last: g, until: null };
        else if (hold.until !== null && ms(g.goneAt) >= ms(hold.until)) hold = { last: g, until: g.goneAt };
      } else {
        close();
        push(g, 'received', iso(g.assignedAt));
        hold = { last: g, until: g.goneAt };
      }
    }
    close();
  }
  return out.sort((a, b) => ms(a.at) - ms(b.at));
}

function byNewest(a: TimelineEntry, b: TimelineEntry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The cursor of an entry: the next page starts after it. */
export function timelineCursor(e: { at: string; key: string }): string {
  return `${e.at}|${e.key}`;
}

/**
 * One page of a newest-first list (by time, then key): entries after `before`
 * (a cursor from the previous page), at most `limit`. `next` is the cursor to
 * ask with for the page after, or null at the start. Entries arriving at the
 * top never shift what the next page returns. Also pages My Clan → Joins &
 * leaves (roster-changes.ts).
 */
export function pageNewestFirst<T extends { at: string; key: string }>(
  list: T[],
  opts: { before?: string | null; limit: number },
): { entries: T[]; next: string | null } {
  let rest = list;
  if (opts.before) {
    const sep = opts.before.indexOf('|');
    const at = sep < 0 ? opts.before : opts.before.slice(0, sep);
    const key = sep < 0 ? '' : opts.before.slice(sep + 1);
    rest = list.filter((e) => e.at < at || (e.at === at && e.key > key));
  }
  const page = rest.slice(0, Math.max(1, opts.limit));
  const next = rest.length > page.length ? timelineCursor(page[page.length - 1]) : null;
  return { entries: page, next };
}

/**
 * One page of a built timeline: entries after `before` (a cursor from the
 * previous page), only the given groups, at most `limit`. `next` is the
 * cursor to ask with for the page after, or null at the start.
 */
export function pageTimeline(
  entries: TimelineEntry[],
  opts: { before?: string | null; groups?: ReadonlySet<TimelineGroup> | null; limit: number },
): { entries: TimelineEntry[]; next: string | null; total: number } {
  const list = opts.groups?.size ? entries.filter((e) => opts.groups!.has(e.group)) : entries;
  return { ...pageNewestFirst(list, opts), total: list.length };
}
