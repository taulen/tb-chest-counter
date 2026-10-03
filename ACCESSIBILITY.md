# Accessibility

## Commitment

TB Chest Counter should be usable by everyone in a clan, not just the person who
installed it. The pages most people see — the leaderboard, a public share link,
member pages — matter most, and barriers there are treated as bugs.

Be clear-eyed about where it stands: this is a hobby project, it has **not had a
formal accessibility audit**, and it does not claim conformance with WCAG or any
other standard. What follows is an honest account of what works, what doesn't,
and how to tell us when something gets in your way.

## Supported environments

- **Browsers:** current versions of Chrome, Edge, Firefox and Safari, on desktop
  and mobile. The frontend relies on ES modules and CSS custom properties, so
  older browsers are not supported.
- **Screen sizes:** phone to desktop. Below 640px wide, tables switch to compact
  rows that expand when tapped.
- **Themes:** Dark (the default), Light and OLED, chosen per user in the
  signed-in site and remembered by the browser.
- **Assistive technology:** not formally tested with screen readers or other
  assistive tools yet. Reports from people who use them are especially welcome.
- **Language:** the interface is English only. Player names are shown in
  whatever script they were read in, including Cyrillic and Arabic.

## What works today

- Data is shown in real HTML tables with column headers, not drawn as images —
  including the leaderboard and the public share page.
- Pages declare their language (`lang="en"`).
- Dialogs are marked up as dialogs and close with **Escape**.
- Small inline charts and status indicators (nav dots, progress bars) carry text
  labels for screen readers.
- Values the app estimates rather than reads — such as a member's Guards level —
  say so in text and in their tooltip, not through colour alone.

## Known limitations

Listed because knowing is better than discovering:

- **Sorting tables needs a mouse or touch.** Column headers can't be reached or
  activated from the keyboard. Every table opens in a meaningful default order.
- **Compact rows on phones don't respond to the keyboard.** The tap-to-expand
  rows used below 640px only open with a tap.
- **Dialogs don't take keyboard focus.** Most dialogs neither move focus into
  themselves when they open nor keep it there, so keyboard users may need to Tab
  to reach their content. The screenshot viewer is the exception.
- **Large charts have no text alternative.** The charts on the Analytics, Might
  and Resources pages are drawn on a canvas. Much of the same data appears in
  tables elsewhere, but not all of it.
- **Leaderboard goal colouring is colour-only per row.** When a clan sets a
  points goal, rows are tinted green, amber or red. The goal and its thresholds
  are stated in text above the table, but each row's status is not.
- **The theme doesn't follow your system setting.** It starts in Dark. Signed-in
  users can switch to Light or OLED from the theme menu; a public share link has
  no switcher of its own and uses whatever that browser last chose.
- **Animations mostly ignore "reduce motion".** They are short fades and slides,
  but only the FAQ button's attention dot currently respects the setting.
- **Contrast hasn't been measured.** Muted secondary text in particular may fall
  below recommended contrast ratios in some themes.
- **The game-facing admin tools are visual by nature.** Calibration means
  clicking points on a screenshot of the game, and the login bridge streams the
  game as live video. The game itself is a WebGL canvas with nothing a screen
  reader can read, and that is outside this project's control.
- **Discord tables are monospace text blocks**, which screen readers tend to
  read character by character.

## Reporting a barrier

If something in TB Chest Counter is hard or impossible for you to use, please
tell us — it doesn't need to be phrased as a technical bug report.

- **Open an issue** with the [bug report form](https://github.com/taulen/tb-chest-counter/issues/new/choose)
  and choose **Accessibility** under "Where", or
- **Ask in [Discussions](https://github.com/taulen/tb-chest-counter/discussions)**
  if you're not sure it's a bug.

It helps to include which page you were on, what you were trying to do, and the
browser and any assistive technology you use (with versions, if you know them).

**Using a clan's TB Chest Counter site?** Report it here, not to that site's
admins: they run the software but can't change how it works, and a fix made here
reaches every site once it updates.

This is maintained in spare time, so expect a reply in days rather than hours.
Barriers on the leaderboard, share links and member pages come before those in
the admin tools.
