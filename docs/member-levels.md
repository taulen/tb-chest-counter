# Levels from chat (Admin → Member Data)

Players post their levels in the in-game chat, e.g. `taulen: G8/M8/S7/E8/C35/D284`. The letters are G Guardsmen, M Monsters, S Specialists, E Engineering, C Crypting and D Dragon. An admin pastes the chat, checks who each name is, and saves. Code: [member-levels-parse.ts](../src/data/member-levels-parse.ts), [member-levels-repo.ts](../src/data/repositories/member-levels-repo.ts), [routes/member-levels.ts](../src/web/routes/member-levels.ts), [member-levels.js](../src/web/public/pages/member-levels.js).

- **Parsing.** The name is everything before the first `:`. After it, each of G, M, S, E, C and D (or the word "dragon") followed by a number is one level; separators, case and stray marks don't matter.
  - The last value of a letter on a line wins, and a repeated player is merged field by field, with later lines winning.
  - Out-of-range or number-less tokens ("E -12", "C/", a bare "/215") are ignored, never guessed at.
- **Matching** is [name-resolver.ts](../src/data/name-resolver.ts), shared with the Tin Man paste: merge rules first, exact on everyone, then fuzzy matching with active members first, one member per paste. Nothing is saved until the admin has seen the matches (preview, then import).
- **Dating.** An import is dated the game day it is saved; there is no date picker on purpose.
- **Storage** (v82, `member_level_reports`): one row per member per import, every letter as reported (NULL = not said). It no longer sets the guards level: since Nov 2026 that is the Guardsmen tier from the member's research, read from the game ([guards-and-gold-pass.md](guards-and-gold-pass.md)). Until then G was also written as an admin guards entry for the donation estimate.
  - FK: member_id cascades on delete, and a player merge repoints it. Clan delete and restore handle the table.
- **Profile.** Only the Dragon level shows, as a stat beside the guards level ("posted in chat <date>"). Research covers the other letters.
- **Reading.** Each member's latest value per letter (a later post that leaves a letter out keeps the old one), next to their guards level from research.
