# Levels from chat (Admin → Member Data)

Players post their levels in the in-game chat, e.g. `taulen: G8/M8/S7/E8/C35/D284`. The letters are G Guardsmen, M Monsters, S Specialists, E Engineering, C Crypting and D Dragon. An admin pastes the chat, checks who each name is, and saves. Code: [member-levels-parse.ts](../src/data/member-levels-parse.ts), [member-levels-repo.ts](../src/data/repositories/member-levels-repo.ts), [routes/member-levels.ts](../src/web/routes/member-levels.ts), [member-levels.js](../src/web/public/pages/member-levels.js).

- **Parsing.** The name is everything before the first `:`. After it, each of G, M, S, E, C and D (or the word "dragon") followed by a number is one level; separators, case and stray marks don't matter.
  - The last value of a letter on a line wins, and a repeated player is merged field by field, with later lines winning.
  - Out-of-range or number-less tokens ("E -12", "C/", a bare "/215") are ignored, never guessed at.
- **Matching** is [name-resolver.ts](../src/data/name-resolver.ts), shared with the Tin Man paste: merge rules first, exact on everyone, then fuzzy matching with active members first, one member per paste. Nothing is saved until the admin has seen the matches (preview, then import).
- **Dating.** An import is dated the game day it is saved; there is no date picker on purpose.
- **Storage** (v82, `member_level_reports`): one row per member per import, every letter as reported (NULL = not said). G is also written as an admin guards report (`member_guards_reports`), at most once per member, day and level. The guards estimator then weighs it like a hand entry: a pin for its date **until newer hard donation evidence arrives**. A tractate tier, or an essence amount only one level explains, dated after the entry, supersedes it. The entry is then left out of the estimate and shown as "replaced" on the profile. An ambiguous essence line (1,001,000 fits G7 and G8) replaces nothing.
  - FK: member_id cascades on delete, and a player merge repoints it. Clan delete and restore handle the table.
- **Profile.** The member's Guardsmen card shows a quiet "Posted in chat" chip row with every letter, named on hover.
- **Reading.** Each member's latest value per letter (a later post that leaves a letter out keeps the old one), next to the guards estimate.
- **Analytics** lists "Levels learned, last 30 days": members whose first known level came from an admin entry. These are not level-ups, since nothing earlier was known, so they never appeared anywhere before.
