# Levels from chat (retired Nov 2026)

Players used to post their levels in the in-game chat, e.g. `taulen: G8/M8/S7/E8/C35/D284` (G Guardsmen, M Monsters, S Specialists, E Engineering, C Crypting, D Dragon). Admin → Member Data had an import for them: paste the chat, check who each name is, save.

**The import is gone (Nov 2026).** Every letter now comes from the game, for every linked member, every day, with history:

- G / M / S / E and the crypt level: the troop tiers from the member's own research ([guards-and-gold-pass.md](guards-and-gold-pass.md), [member-tiers.ts](../src/data/member-tiers.ts)).
- D: the Dragon itself, city field 26 — level, XP, evolution and the name the player gave it ([game-protocol.md](game-protocol.md#the-dragon-city-field-26-profile--captains)). It shows on the profile as the Dragon stat and on the Captains tab as the Dragon card, and its level-ups are on the Timeline.

Removed with it: the parser, its repository and route (`/api/member-levels`), the admin card, its strings, and the profile's "posted in chat" Dragon stat.

**Kept: the `member_level_reports` table (v82) and every row in it**, as the record of what players said. Nothing reads it any more. Clan delete and restore still handle the table; the audit log's `member_levels_import` entries keep their label on the Users page. The name resolver the import shared with the event standings paste went with that paste (Nov 25 2026).
