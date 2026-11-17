# Game protocol (direct client)

Total Battle's web client talks to its servers over plain HTTPS with a binary
MessagePack format. We speak it directly — no browser, no OCR — to read the clan
record (members + both gift tabs), player records, the Clan Capital ledger and
any player's city (research + hero talents). Code: [`src/game-protocol/`](../src/game-protocol/).

Status (Nov 2026): **parallel run.** [`game-protocol-phase.ts`](../src/scheduler/game-protocol-phase.ts)
runs before each clan's OCR scan and stores what the game says in the `game_*`
tables (migration v102). Nothing reads them for scoring yet; the OCR pipeline is
unchanged. Toggle: `GAME_PROTOCOL_CAPTURE_ENABLED` (default on).

After each scan, `compareScanWithGameCapture` matches that scan's OCR rows
against the gift list the capture saw just before it (per tab, by sender +
chest + source) and stores the result in `game_scan_comparisons`; one
`[game-vs-ocr]` log line per scan summarises matched / probable name misreads /
OCR-only / game-only. Read it with
`echo "SELECT * FROM game_scan_comparisons ORDER BY created_at DESC LIMIT 10" | ssh tb-read sql`.

## Rules that bite

- **Never present an old website token.** The site rotates its JWT on every
  `GetGameStartData`; sending a superseded one gets `Invalid token` **and ends
  that account's website session** (the stored session cookie stops working, so
  the scanner needs re-authentication). The client therefore always takes a
  fresh token from `GET /en/` and never stores one. This happened once to SK7
  during development (Nov 17 2026).
- **A direct login takes over the account's game session.** The phase runs
  before the clan's browser is launched; the scan's own fresh navigation then
  takes the session back. Never run the client while a browser for the same
  account is mid-scan.
- **The game server gets no cookies.** Its only auth is the session id from
  the login reply. The website cookies are only for steps 1–2 below.
- Only our own clan's record carries members and gifts; records of other clans
  (fetched when browsing rankings) come with empty lists.

## Login chain

1. `GET https://totalbattle.com/en/` with the clan's stored cookies
   (`data/clans/<id>/storage-state.json`). The reply sets a fresh
   `__Host-user_auth_token` (JWT), and the page embeds the game account id
   (`"suid":"tb:…"`) and a `realm_id → logic_url` map of game servers. A
   logged-out page (no suid) means the clan needs re-authentication.
2. `POST /restapi/totalbattle/web/` JSON-RPC `GetGameStartData(suid, token,
   human_data)` → `sig`, `realmID`, `stringGuid` (player id), `accountId`,
   `human_data` (server echo: ip, country, language, email), `new_token`.
3. `POST <logic_url>` message **203**, seq 1, zero session id, body
   `[[suid], [""], sig, loginHumanArray, "", 0, 0, deviceId, 0, 1, "{}",
   [accountId, createdAt], deviceInfo, ["webgl", clientVersion]]`. The human
   array is the client's fixed field order (12 fields, two blanks, the rest) —
   see `loginHumanArray`. Reply `body[0]`: `[2]` session id (12-byte bin),
   `[0][0]` player id, `[6][2]` `[nickname, [clanId], …]`, `[6][1][3]` realm.
4. Every further message: head `[type, ++seq, [[playerId], sessionId], ""]` +
   body. No trailer needed.

The device identity (`deviceId`, fingerprint) is generated once per clan and
kept in `data/clans/<id>/game-device.json`. The WebGL client version isn't in
any text endpoint; it's `DEFAULT_CLIENT_VERSION` (override:
`GAME_CLIENT_VERSION`). A login with no session in the reply after a game
update is the cue to refresh it.

## Wire format

Frame: `u32le len` (whole frame) · `u32le replyLen` (header + message) ·
message · trailer. Message = MessagePack **with little-endian multi-byte
numbers and lengths**: a head `[type, seq, …]` then body values. Type 2 is a
batch of nested frames. Reply trailers are pushed events (`u32le len` incl.
itself, `[objectId, evType, ts, code]`, body); request trailers are event acks
`[[streamId, lastCount], …]` (not a checksum). The encoder writes the smallest
form for each value — 181 captured requests re-encode byte-identical.

## Messages

| Type | Ask (body) | Reply |
|---|---|---|
| 15000 | `[[[[clanId], 2147483647]]]` | clan record: `[0]` clan id, `[1]` tag/name/description, `[2]` members `[[id], role, joinedAt]`, `[3]` ~860 `[[id], ts, 0]` (departures), `[13]` gifts `[giftId, [senderId], giftType, expiresAt, count, tab]` |
| 402 | `[[[id], [id], …]]` | player records: `[1]` suid, `[2]` name, `[4]` hero avatar (T13), `[7]` hero level, `[8]` city level, `[9]` VIP, `[10]` might, `[11]` clan id, `[13]` clan tag, `[15]` `[realm,x,y]`, `[16]` city id, `[22]` `[1]` = Gold Pass |
| 15031 | `[[[clanId], 0]]` | ledger `[entryId, [playerId], kind, resource, ts, [{res: amount}]]`, ~14 days (second value is not a filter) |
| 601 | `[[[[[cityId], 0, 2147483647]]]]` | city details; the `{techId: [techId, level]}` map holds research and hero talents |
| 312 | `[[[tileIds], [versions], [], []]]` | map objects per 20×20 tile; `tile = floor(y/20)*50 + floor(x/20)` |

Gifts: lifetime 20 h (arrival = expiry − 72000 s). `tab` 1 = Gifts, 2 =
Triumphal; `count` is chests in the entry (Bank bundles 3 or 30). Gift ids are
sequential per clan, so gaps are losses. Ledger kinds seen: 4 donation (res 20
Scientific Tractates, 31 Dragon Coins, 21–23 Boards/Cement/Steel, 74284 Magic
Seeds), 7 Forest Essence (74285), 3 basic resources (2–6), 2 speed-up with item
counts (2050 1h, 2051 3h, 2052 8h, 2053 15h, 2054 24h, 2055 72h).

## Names (static data)

[`static-data.ts`](../src/game-protocol/static-data.ts) builds `names.json` per
game version under `data/game-static/<version>/` from the game's public CDN:
`versions.totalbattle.com/config/?branch=current&simple=true` →
`client_static_version.production` (strings, vectors, no_duplicates) and
`client_translations_catalog_version` → `csv_en_US` zip. Table cells reference
the string pool by index; localised text is a **vector** of string refs, and
templated text is `[template, placeholder, value, …]` ("Level %value% Crypt").
Each table has its own id space:

| Table | Holds | Name |
|---|---|---|
| 7 | map objects | f3 vector |
| 8 | gift types | f3 chest name, f14 source template |
| 13 | hero avatars | f1 name, f3 icon |
| 21 | techs (research ~1000–1840, talents 25xxx/29xxx) | f1 name, f5 levels |

A rebuild downloads ~67 MB and decodes only these four tables (the rest are
skipped unbuilt), about 7 s.

The game's source text differs from what OCR stored in places ("Level 25–29
Vault of the Ancients" vs our "Lvl 25-29 …"); switching sources over needs a
mapping onto existing names so history stays continuous.
