# Accounts from the game (invite codes in the game chat)

Site accounts are made by the players themselves, with a one-time code the
clan's **scanner account** sends them in the game chat (v127, Nov 2026). The
code proves they own the game player, so the account is **linked to that
player**, and its role in the clan **follows the in-game rank** from then on.
The superadmin and the old password accounts keep working as before.

Code: [account-invite-repo.ts](../src/data/repositories/account-invite-repo.ts)
(codes, links, joining, role sync), [chat-invites.ts](../src/scheduler/chat-invites.ts)
(requests, replies, welcome codes), [chat-send.ts](../src/game-protocol/chat-send.ts)
(`assertInviteChannel`, `sendInviteMessage`), [routes/join.ts](../src/web/routes/join.ts)
(`/api/join`), [routes/clans/account-invites.ts](../src/web/routes/clans/account-invites.ts)
(settings), [join.html](../src/web/public/join.html) / [join.js](../src/web/public/join.js),
[clan-account-invites.js](../src/web/public/pages/clan-account-invites.js).

## Getting a code

Two ways, each its own per-clan setting under **Clans → Account invites via
chat**, both **off by default**, switched by that clan's admins or the
superadmin:

1. **Asking** — the player DMs the scanner account one word: `code`,
   `invite`, `tracker`, `код`, `código` or `codigo` (the whole message, any
   case; a leading `!` or `/` and trailing punctuation are fine). The chat is
   read every minute; the answer goes out within a minute when the clan's last
   scan left a game session for a chat token, else with the clan's next scan.
   Code: 72 hours (the same as a welcome code).
2. **Sent to members** (welcome codes; mode off / dry run / on) — the scanner
   account opens a private chat and sends a code. The **first time** it is
   switched on, every current member without an account is due one (the
   backlog); after that, every player who joins. At most **10 per scan**, 2–4 s
   apart; switching it off stops it where it is (switching it on again carries
   on, it doesn't start over). Progress shows in the settings: "Codes sent: 34
   of 98". Code: **72 hours** (a new member may not read the chat for a while).
   **Once per player per clan, ever** (`chat_invite_welcomes`): a rejoin never
   resends. **Dry run** only lists and logs who would get a code (never the
   code) and sends nothing — those players are still due once it is on.

The messages carry **no link**: the game blocks them. The site is written as
its host with a space around each dot — "Go to cwb . fyi and pick "Have a
code? Join here"" — from the public address (the clan's own domain, else
`WEB_EXTERNAL_URL`), or the instance-wide override set by the superadmin
(*Site name in messages*, stored as `INVITE_SITE_NAME` in `data/app.env`). The
sign-in page has the **Have a code? Join here** button (keep its English in
step with `JOIN_ENTRY_LABEL`), which leads to `/join`.

The messages (English, one line, at most 300 characters):

- Reply: `TB Chest Counter code: ABCD-EFGH. Go to cwb . fyi and pick "Have a code? Join here" within 72 hours. It works once.`
- Welcome: `Welcome to <clan>! Your TB Chest Counter code: ABCD-EFGH. Go to cwb . fyi and pick "Have a code? Join here" within 72 hours. It works once. Reply "code" any time for a fresh one.`
  (The clan name is left out when it looks like a link.)

## Who gets an answer (the safety rules)

Sending into a private chat is otherwise never allowed ([chat-digest.md](chat-digest.md));
these are the only two exceptions, each narrowly scoped:

- **Only to the one player, in a 1:1 chat.** `assertInviteChannel`: a
  `whisper` channel (never a clan or kingdom URL) whose members are exactly
  the scanner account and that player. A welcome's freshly opened chat is
  checked the same way before anything goes in.
- **Only roster members.** A non-member gets no answer at all (logged once a
  day, without an alert).
- **Only after it was switched on**, and a request no older than 6 h.
- **The chat account must be the player's.** The player id comes from chat
  metadata (`memberInfo`), which a modified client could fake. So the asker's
  chat account (`tb:<n>`) must be the one pinned when the player linked, or —
  before that — no stored message may show the player writing from a
  different chat account. A mismatch is refused and raises a warning. A
  welcome finds the chat account from the player's own stored lines, else the
  clan chat member whose `memberInfo` names the player AND whose name is the
  roster name — exactly one, or nothing is sent.
- **One code per player per 10 minutes**, one open request per player.
- **Every keyword DM is recorded once** (`chat_invite_requests`), answered or
  not, so nothing is answered twice.
- **Outcomes like the digest:** `sent`; `refused` (nothing went out) → the code
  is withdrawn and it is tried again, up to three times; `unknown` (no answer)
  → never resent. A reserved send is marked `sending` with the code's hash in
  one transaction first, so a crash never sends twice.
- **`CHAT_SEND_DISABLED=1`** stops every send (and requests are recorded as
  ignored).
- **No code is ever logged or stored in plain text** — only its sha256.

## Joining (`/join`)

Codes are 8 characters from an alphabet without 0/O/1/I/L, single use, bound
to the clan and the player; the player must still be on the roster when it is
used. `/api/join/check` says what the code does, `/api/join/redeem` does it,
in one transaction:

| Visitor | Code's player | Result |
|---|---|---|
| signed out | has no account | **new**: choose a username (prefilled from the in-game name) and password |
| signed out | has an account | **recover**: choose a new password; every old session ends |
| signed in | — | **add-clan**: the code's clan is added to the account |
| signed in, old account, own clan | — | **link**: the old account is linked; its role now follows the rank |
| signed in | linked to another account | refused — the superadmin can unlink |
| signed in | another player linked here | refused |
| superadmin | — | refused — superadmins are never linked |

Signed out, the way in is the sign-in page's "Have a code? Join here". Signed
in, the same words sit in the account menu (sidebar foot; the More sheet on a
phone) — the in-game message tells players to pick them, so both doors carry
that label.

Every attempt counts against the caller's address (20 per 15 min) and failed
ones again on their own (10 per 15 min). A wrong, used or expired code all
answer the same.

## Roles follow the rank, every scan

`syncLinkedAccounts` runs at the end of every scan's member sync
([member-sync.ts](../src/game-protocol/member-sync.ts)), **both directions**:

- **Leader or Superior → admin** in that clan; **Officer, Veteran, Soldier →
  user**. A promotion grants admin, a demotion takes it; in a leadership
  transfer the new Leader gains it and the old one keeps it at Superior, loses
  it lower.
- The **home clan** (`users.role`) and each **extra clan**
  (`user_clan_access.role`) follow their own player's rank separately.
- `validateSession` re-reads the role on every request, so a demotion takes
  effect on the account's **next request** — no stale session rights.
- **Gone from the roster** → no access to that clan (the extra grant goes;
  for the home clan the home moves to another linked clan still theirs, or the
  account is paused and its login refused until they are back). Back on the
  roster → the access returns. A roster under 5 players (a partial read)
  changes nothing.
- Every change is audited with `source: 'game'` (`account.role_from_game`
  with from/to role and from/to rank, `account.left_in_game`,
  `account.rejoined_in_game`, `account.home_moved`). The member timeline
  already shows rank changes ("Promoted to Superior") as plain lines.
- **Superadmins are never linked or touched.** Promoting an account to
  superadmin drops its links.

On the Users page a linked account shows its player under the name ("In game:
Name · Rank"), its role can't be changed by hand there (409: unlink first),
and the superadmin can **Unlink** (the account keeps its access as a plain
grant). Creating accounts by hand is **superadmin-only**; old password
accounts show "Not linked (old account)" and are never removed automatically.

## Untested live (Nov 2026)

- **Opening a private chat** for a welcome code (`openPrivateChat`: Sendbird
  `POST /v3/group_channels`, `is_distinct`, `custom_type: whisper`, the two
  chat accounts) and **the clan chat's member list** with metadata were not
  captured from the game client: run the welcome codes in **dry run** first,
  then switch on and watch the first sends (System log).
- **The reply path** uses the same socket send as the digest, into a chat the
  player opened; the first live reply is also the first real test of it.

## Tables (v127)

`account_invite_settings` (per clan: enabled + enabled_at; welcome_mode,
welcome_enabled_at, welcome_backlog_at), `user_game_links` (account ↔ player
per clan, chat_user_id, rank, on_roster), `chat_invite_requests`,
`chat_invite_welcomes`, `account_invite_codes` (sha256 only, kind
reply/welcome). Deleting a clan or a user clears them
([fk-delete-guards.test.ts](../tests/data/fk-delete-guards.test.ts)).
