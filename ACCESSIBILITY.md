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
- **Themes:** Auto, Light, Dark and OLED. Auto follows your device — Light in
  light mode, OLED in dark mode — and is what you get until you choose. Signed-in
  users pick from the user menu (or the phone menu); a public share link has its
  own picker in the header, remembered by that browser.
- **Assistive technology:** not formally tested with screen readers or other
  assistive tools yet. Reports from people who use them are especially welcome.
- **Language:** the interface is English only. Player names are shown in
  whatever script they were read in, including Cyrillic and Arabic.

## What works today

- **Tables are real HTML tables** with column headers, not images — including
  the leaderboard and the public share page.
- **Sorting works from the keyboard.** Every sortable column header is a button:
  Tab to it, press Enter or Space, and focus stays on it after the table
  re-sorts. Screen readers hear which column is sorted and in which direction.
- **Compact rows on phones open from the keyboard.** Below 640px wide, a row
  with hidden columns can be reached with Tab and opened with Enter or Space,
  and announces whether it is expanded.
- **Dialogs hold focus.** Opening one moves keyboard focus into it, the page
  behind can't be reached until it closes, Escape closes only the topmost
  dialog, and focus returns to whatever opened it. Enter in a confirmation does
  what the focused button says, and destructive confirmations open on Cancel.
  The phone menu behaves the same way.
- **The login bridge doesn't trap the keyboard.** Every key typed in the game
  view goes to the game, except **Shift+Esc**, which leaves it.
- **Charts have text alternatives.** Each chart on the Analytics, Might and
  Resources pages has a one-line summary for screen readers and a "Show data as
  table" option under it with every value it draws.
- **Colour is never the only signal.** The leaderboard's goal colours, the
  Analytics top contributors and the ChestTracker tab's target colours each
  carry a symbol (✓ reached, ◐ close, ↓ below) and the status in words.
- **Text contrast meets WCAG AA (4.5:1)** in all four themes, for every text and
  background pair the interface paints. A test checks this on every build, so
  a colour change that breaks it can't ship.
- **"Reduce motion" is respected.** With the system setting on, animations and
  transitions are cut to nothing, and charts draw without animating.
- **Keyboard focus is always visible**, with a focus ring in every theme.
- **Status changes are announced.** Notifications are read out without moving
  focus, and the navigation's "needs review" dots carry text for screen readers.
- **Estimated values say so.** Values the app infers rather than reads, such as
  a member's Guards level, say so in text and in their tooltip.
- Pages declare their language (`lang="en"`).

## Known limitations

Listed because knowing is better than discovering:

- **Tables can't be sorted on phones.** Below 640px wide the header row is
  hidden to fit the compact layout, so columns can't be re-sorted there — by
  touch or keyboard. Every table opens in a meaningful default order.
- **Not tested with assistive technology.** The work above follows the
  standard patterns, but nobody has yet run the site with a screen reader end to
  end.
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
