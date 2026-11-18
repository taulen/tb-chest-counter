# In-game chat digest

The daily digest, posted into one of the clan's **in-game group chats** by the
clan's own scanner account: the "Daily Digest — 15 November / Our top 20
crypters" message CWB's leaders used to post by hand in "CWB • Carter".
Opt-in per clan (Clans → *In-game chat digest*); CWB starts enabled into
"CWB • Carter" while it is tested (migration v116), every other clan starts off.

Code: [scheduler/chat-digest.ts](../src/scheduler/chat-digest.ts) (format,
schedule, coverage, the hook),
[game-protocol/chat-send.ts](../src/game-protocol/chat-send.ts) (guards and the
send), [chat-digest-repo.ts](../src/data/repositories/chat-digest-repo.ts),
[routes/clans/chat-digest.ts](../src/web/routes/clans/chat-digest.ts),
[pages/clan-chat-digest.js](../src/web/public/pages/clan-chat-digest.js).

## The rules (clans mute spammers)

- **At most one message per clan per game day**, scheduled or test. A row in
  `chat_digest_posts` is reserved (status `sending`) in a transaction *before*
  anything is sent, unique per (clan, digest day), and no second message goes
  out on a game day that already had one. Restarts and redeploys can't repeat it.
- **One message, never split.** The ceiling is the size of the hand-written
  post: **898 characters / 1,114 UTF-8 bytes** (2 header lines + 20 entries,
  measured from the user's 15 November screenshot; every channel's own limit
  is `max_length_message: 1000`). Longer names shorten the dot leaders first,
  then the names ("…"), then entries drop from the bottom. Entries: 3–20.
- **Retries:** a send the chat service *refused* (nothing went out) is retried
  once, on a later scan. While the game has the scanner account **muted**
  ("You are muted."), nothing is posted until the pause is over
  ([account-invites.md](account-invites.md#when-the-game-mutes-the-scanner-account)). A send with no answer (`unknown`) — or a row left
  `sending` by a crash — is **never** resent.
- **Only the chosen named group chat.** `assertPostableChannel` refuses the
  clan chat (`clanGroup`, `triumph_clan_channel_*`), the kingdom chat
  (`realmGroup`, `triumph_realm_channel_*`), private chats (`whisper`) and every
  other kind by type *and* URL; only `publicGroup` / `privateGroup` with a name.
  The settings picker lists only those, and only chats the scanner account is a
  member of (its `my_group_channels`, read at every scan of an enabled clan).
- **Coverage:** a day is posted only when the scans covered it — the last scan
  before it, every scan inside it and the first after it closed, with no gap
  over **3 h** (`COVERAGE_MAX_GAP_H`). Otherwise it is skipped with a warning
  (System → Needs attention, resolved by the next successful post). Gifts live
  ~20 h, so 3 h is deliberately cautious.
- **Kill switch:** `CHAT_SEND_DISABLED=1` (docker-compose.yml) stops every send.
- **Saving the settings never posts.**

## The only exceptions: account-invite codes in a private chat

Nothing else ever goes into a private chat — except an account-invite code
([account-invites.md](account-invites.md)), through its own narrower path
(`sendInviteMessage` / `assertInviteChannel`), never through
`assertPostableChannel`, which still refuses every private chat:

1. **A reply**: a player DMs the scanner account a keyword; the answer goes
   back in that same 1:1 chat. Per-clan setting, off by default.
2. **A welcome code**: the scanner opens a 1:1 chat with a member and sends
   one code — on the first switch-on to every current member without an
   account, then to each player who joins; once per player per clan, ever;
   at most 10 per scan, a few seconds apart. Its own per-clan setting
   (off / dry run / on), off by default; opening the chat is untested live.

Both: only into a `whisper` channel whose members are exactly the scanner and
that one player, only roster members, no link in the text (the game blocks
them), never an `unknown` outcome resent, `CHAT_SEND_DISABLED=1` stops them.

## When

At the end of a scan (it needs the scan's game session for a chat token): the
first scan after the daily reset (17:00 UTC rollover) posts the game day that
just closed — no time to set (user, Nov 2026). A day is only posted within
**6 h** of the reset (): switching the digest on later in
the day, or a long outage, skips it rather than posting a stale list the
leaders already posted by hand (enabling it at midday on Nov 17 posted the
15 November list). "Send test post now" queues the latest closed day for the
clan's next scan, however late — it uses that day's one message, so the
scheduled one doesn't follow.

## What

The numbers are the Discord daily digest's (`getDailyDigestData`: the game
day's chests and points per member, ranked by points, clan-reward chests
excluded). They reproduce the hand-written 15 November post exactly (Princess
of Chaos 35 chests (5,815), jass 13 (3,560) … Granizel 9 (310)).

**Language** (per clan, v122; en by default): en / es / fr / ru / de. The
header, the month ("15 de noviembre", "15 ноября", "15. November") and the
chest plural (Intl.PluralRules: 1 сундук, 22 сундука, 13 сундуков) follow it,
numbers take the language's grouping ("3.560", "3 560") — unless that costs
entries against the size cap (a French narrow no-break space is 3 bytes), then
the plain grouping. English is the hand-written post word for word.

## How it is sent

As the game client sends: a chat token from the game session (message 414),
the Sendbird socket opened with it, one `MESG` frame
`{channel_url, message, data: "", custom_type: "user", mention_type: "users",
req_id}`; the server echoes the message with its `msg_id` (sent) or answers
`EROR` (refused). The account that posts is the clan's scanner account (CWB:
D4DDYLiZ); it must be a member of the chosen chat — when it isn't, the
settings say so and nothing is sent.
