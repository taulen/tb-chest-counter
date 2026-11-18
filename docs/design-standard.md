# Design standard (the redesign's UI kit)

Every page is built from one kit so the site reads as one product. The kit is
two files:

- **[lib/ui-kit.js](../src/web/public/lib/ui-kit.js)**: helpers that return HTML strings or wire a
  piece already in the page.
- **style.css, section "UI kit"**: the `.ui-*` classes. Page blocks below it
  (`.mboard-*`, `.home-*`, `.lb-*`, …) keep only what is theirs.

Reference pages: **Leaderboard** (`pages/leaderboard.js`), **Home**
(`pages/home.js`), **Members board** (`pages/members-board.js`). When a page
needs something the kit doesn't have, add it to the kit (both files, and this
doc), not to the page.

## Rules that apply to every page

- **Words.** Members **collect** chests, which come **from** a source ("from a
  level-25 crypt"). Only the scanner account *opens* gifts. Never "opened" about
  a member.
- **Notices are information, never advice or alerts.** A burning city, a join,
  a leave, a rank change is a plain fact with a time. No red boxes, no "do X".
- **Colour is never alone.** Every status carries a glyph and words:
  ✓ Reached, ◐ On pace, ↓ Behind, ▲ / ▼ deltas.
- **Dates and times.** ISO dates (2026-11-18), 24-hour times, the viewer's own
  clock ("Today 07:14", "Yesterday 04:12"), UTC added where the game's clock
  matters (resets at 17:00 UTC). Periods follow the game day (lib/period.js),
  never calendar math.
- **Translation.** Every visible string goes through `t()` / `tn()` with a
  literal, with entries in all four `lib/i18n/*.js` dictionaries (the build
  fails otherwise). Game names go through `tGame()` at display points only.
- **Phone first.** Most members read on a phone. Targets ≥ 44px. The first
  useful row shows on the first screen. Nothing scrolls the page sideways: wide
  strips scroll inside themselves.
- **Theme.** Theme variables only, never a hard-coded colour. Design and check
  OLED first, then light; Dark is secondary.
- **API answers.** `api()` returns whatever JSON the server sent, so a refusal
  (429, a 500's `{ error, ref }`) arrives as an object where a list was
  expected. Wrap lists in `asList()`; for the page's main list, show
  `errorStateHtml()` with Try again.

## Components

### Page header (the shell's) + page actions

Every page's title and one-line subtitle come from the shell (`#pageHead`,
`PAGE_SUBTITLES` in app.js). Never draw a second header. A page's own buttons
go beside the title:

```js
import { setPageActions } from '../lib/ui-kit.js';
setPageActions(`<button type="button" class="btn" data-action="open-leaderboard-faq">${esc(t('FAQ'))}</button>`);
```

The shell empties `#pageActions` on every navigation. Call it on each render.

### Sub-tab bar

For a page with sub-pages (Events, Tools, Admin, Resources, My Clan,
Members/Might). These are real links, so a sub-tab can be bookmarked, opened in
a new tab and reached with Tab. The current one has `aria-current="page"`. On a
phone it is a strip that scrolls sideways, never a second row.

```js
subTabsHtml({
  label: t('Events'),
  current: 'ancients',
  items: [
    { key: 'ancients', label: tGame('Rise of the Ancients'), href: '#events/ancients' },
    { key: 'olympus', label: tGame('Olympus'), href: '#events/olympus' },
  ],
});
```

Old links (`#events/ancients`) keep working, because the href is the route.

### Period scrubber

Day / Week / Month (/ Year) / All, the earlier and later arrows, and where in
the window we are. The phone version is one line ("2026-11-15 → 21 · day 3 of
7"). It is the one control for "which window"; never build another.

```js
el.innerHTML = periodScrubberHtml({ periods: ['daily', 'weekly', 'monthly', 'all'],
  period, offset, rolloverHr, weekStart, win: computeGameWindow(period, offset, rolloverHr, weekStart) });
wirePeriodScrubber(el, { onPeriod: (p) => { … }, onStep: (delta) => { … } }); // +1 = earlier
```

A past window is judged against the goal it was played under:
`weeklyGoalForWindow` / `resolveWeeklyGoalForWindow`, never today's number.

### Segmented control and chips

- `segHtml({ label, items: [{ value, label }], current, attr })` picks one of a
  few: Board | Table, Day/Week. It uses `aria-pressed`; wire clicks on
  `[data-<attr>]`.
- `.ui-chip` (`.is-active`, `.ui-chip-n` for a count) is for filters with
  counts (the bands). A row of chips scrolls sideways on a phone.

### Tiles on the bento grid

```js
`<div class="ui-grid">${tileHtml('top', t('Top collectors'), body, { span: 4, link: tileLinkHtml('#leaderboard', t('Leaderboard')) })}</div>`
```

- **Desktop:** 12 columns; a tile spans 4, 6, 8 or 12.
- **Tablet (≤ 1100px):** halves and wholes.
- **Phone (≤ 760px):** one column, in source order. Put each role's most
  personal or most important tile first.

### Row list

```html
<ul class="ui-rows">
  <li class="ui-row">
    <span class="ui-rank">#1</span> {avatarHtml(...)}
    <span class="ui-row-main"><a class="ui-row-name" href="…">Name</a><span class="ui-row-sub">12 chests</span></span>
    <span class="ui-row-n">58,860</span>
  </li>
</ul>
```

Every row is ≥ 44px tall. The name ellipsizes, and the figure on the right
stays whole.

### Numbers, deltas, bands, the goal bar

- **Stat:** `<div class="ui-big">12,345<span class="ui-big-of"> / 40,000</span></div>`
  plus `<div class="ui-stat-label">…</div>`. `.is-xl` makes the number larger.
- **Delta:** `deltaHtml(delta, label)` renders ▲ / ▼ / ± and the number, plus
  words ("vs last week by now").
- **Band:** `bandHtml('ok' | 'pace' | 'behind')` renders "✓ Reached",
  "◐ On pace" or "↓ Behind".
- **Goal bar:** `barHtml({ points, goal, pace, band, max })` draws the fill in
  the band's colour, the goal line (bright) and the pace line (thin, only while
  the period runs).

### Stat tiles

A row of headline numbers (My Clan's members, might, wealth; Triumphal's
totals): as many to a line as fit, two on a phone. A tile with `href` is a
link (a rank that opens its ranking).

```js
statTilesHtml([
  statTileHtml({ label: t('Members'), value: `80<span class="ui-big-of"> / 100</span>`, sub: '+11 since 2026-11-16' }),
  statTileHtml({ label: t('Rank by wealth'), value: '#12', href: '#clan/rankings', attrs: 'data-goto-ranking="7"' }),
]);
```

### Titled table card

A table (or list) with a heading: `tableCardHtml({ title, hint, before, body, foot })`
puts the title and a quiet hint ("read from the game 2026-11-18") in the
card's head, optional padded content above the table (`before`: a picker of
chips, a summary line), the table full-bleed, and the `.pagination` as `foot`.
It is `.ui-table-card` with a `.ui-card-head`, so the table rules above apply.

### Notices, empty, error

- **Notices:** `notesHtml([...lines])` renders plain facts in a quiet box.
- **Empty:** `emptyHtml(t('Nobody collected a chest in this timeframe.'))` says
  what is missing in one sentence.
- **Error:** `errorStateHtml(t('The board could not be loaded.'), refusalText(answer))`
  plus `wireRetry(el, again)`. Use it for the page's main data. Smaller lists
  fall back to `asList()` and their empty line.

### Tables

A ranked or sortable table sits in `.ui-table-card`, with `.ui-table` on the
`<table>`, and the site's `.pagination` as the card's last child. The site's table rules still
hold:

- **Locked widths:** `table-layout: fixed` + `<colgroup>`. Fix a long
  translation by shortening it, never by unlocking the table.
- **25 rows a page.**
- **Rank stays canonical across sorts and left-aligned;** narrow the rank
  column rather than right-aligning it.
- **Sortable headers** come from `sortableThHtml` (lib/sort-headers.js): a real
  button with `aria-sort`.
- **Phone compact rows:** tag cells with `data-role` (`lead`, `primary`,
  `metric`, `hidden`; lib/mobile-rows.js). Unmarked cells go to the
  tap-to-expand panel.

## Do / don't

| Do | Don't |
|---|---|
| Build from the kit; add missing pieces to it | Copy a control into a page's own CSS block |
| One plain line per fact, with its time | Alerts, advice, "say hello" prompts |
| `asList()` before `.map` on an API answer | Assume `/leaderboard` always returns an array |
| Glyph + words for every status | Colour alone |
| `t('…')` with a literal; `tGame()` for game names | Build a translated string from pieces |
| Phone first, then desktop; OLED first, then light | Design on a desktop in Dark and shrink it |
| Links for navigation (sub-tabs, rows) | `onclick` on a div, or buttons that change the URL by hand |

## Checking a page

Use the local-ui-check rig (`.claude/skills/local-ui-check`):

1. Screenshot desk 1440 + phone 390, OLED then light, en + ru (the longest
   strings).
2. Run `layout-check.cjs` and `padding-check.cjs` for the page.
3. Read the PNGs.
