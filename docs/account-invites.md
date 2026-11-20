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

Three ways, all under **Clans → Account invites via chat**. The first two
are per-clan settings, both **off by default**, switched by that clan's
admins or the superadmin; the third is always there for them:

1. **Asking** — the player DMs the scanner account one word: `code`,
   `invite`, `tracker`, `код`, `código` or `codigo` (the whole message, any
   case; a leading `!` or `/` and trailing punctuation are fine). The chat is
   read every minute; the answer goes out within a minute when the clan's last
   scan left a game session for a chat token, else with the clan's next scan.
   Code: 72 hours (the same as a welcome code).
2. **Sent to members** (welcome codes; mode off / dry run / on) — the scanner
   account opens a private chat and sends a code. The **first time** it is
   switched on, every current member without an account is due one (the
   backlog); after that, every player who joins. **One at a time**: one code
   a run, at least **10 minutes** after the scanner's last invite DM (a reply
   counts too) — **20 minutes** for a week after a mute. Runs come after each
   scan and, between scans, every minute from the chat poller while the
   scan's game session is kept (a run that found no one to send to waits 10
   minutes before reading the clan chat's members again). Switching it off
   stops it where it is (switching it on again carries on, it doesn't start
   over). It used to be 10 a scan, 2–4 s apart: on Nov 18 2026 two manual
   scans sent 20 in three minutes and the game muted the scanner account for
   an hour (see [When the game mutes the scanner account](#when-the-game-mutes-the-scanner-account)). Progress shows in the settings: "Codes sent: 34
   of 98". Code: **72 hours** (a new member may not read the chat for a while).
   **Once per player per clan, ever** (`chat_invite_welcomes`): a rejoin never
   resends. **Never our own scanner account** — any clan's scanner player
   (`clan_scan_accounts.player_id`, noted by every scan), and before a scan
   has noted it, any candidate whose chat account is the scanner's own: it
   sends the codes. (Nov 19 2026: CWB's scanner player D4DDYLiZ was queued;
   the chat "opened" with itself failed the 1:1 check. v133 dropped that row;
   the list and the counts leave scanner players out.) The section's first
   line names the scanner account's player. **Dry run** only lists and logs who would get a code (never the
   code) and sends nothing — those players are still due once it is on.

3. **Made by hand** (v132, Nov 2026) — for when the scanner account can't
   send one (muted, or the player doesn't read the chat). Under the same
   section, **Make a code yourself**: a clan admin (or the superadmin) picks a
   roster player and gets the code on screen, with **Copy code** and **Copy
   message** (the chat reply's wording — English, no link — so it can go in
   the game chat or anywhere else). Nothing is sent; the admin passes it on.
   The same code otherwise: 72 hours, single use, bound to the clan and the
   player (`account_invite_codes.kind = 'manual'`, no chat account,
   `issued_by` = who made it). Making another for the same player withdraws
   the earlier unused one; at most 50 unused per clan; **Withdraw** stops one
   at once. The list shows who made each, for whom, and what became of it —
   never the code (only its hash is kept; the page shows it until it is left).
   It doesn't count as a chat code: no 10-minute cooldown for the player's own
   request, and a pending welcome isn't marked "asked themselves".
   **The guard:** whoever holds the code becomes that player, so a code made
   by hand never takes over an existing account unless the superadmin made
   it. A clan admin can't make one for a player who already has an account
   (409), and at redeem time — signed out, the player has an account by
   then, maker not (or no longer) superadmin — it is refused as
   `manual-recover`. Otherwise a clan admin could reset the password of an
   account that also holds other clans. The superadmin's code resets it like a
   chat code; a superadmin's own players get none.

The messages carry **no link**: the game blocks them. The site is written as
its host with a space around each dot — "Go to cwb . fyi and pick "Have a
code? Join here"" — from the public address (the clan's own domain, else
`WEB_EXTERNAL_URL`), or the instance-wide override set by the superadmin
(*Site name in messages*, stored as `INVITE_SITE_NAME` in `data/app.env`). The
sign-in page has the **Have a code? Join here** button (keep its English in
step with `JOIN_ENTRY_LABEL`), which leads to `/join`.

The messages (English, one line, at most 400 characters — `MAX_INVITE_REPLY_CHARS`;
the chat takes 1000). **The wording varies** from message to message (user,
Nov 18 2026): the scanner account sends many alike, and a spam filter reads
repeats. Each part has a few versions picked at random — the opener or
greeting, the code line, "Go to / Open / On / Visit", the signed-in door,
the validity, the "fresh one" line — but every version says the same things:
the code, **TB Chest Counter, the clan tracker by taulen** (user, Nov 18
2026), the site, both door labels word for word, 72 hours, single use. When
a random pick would run long, the first (shortest) versions are used; a
welcome then drops the clan name. Two of the versions:

- Reply: `Your TB Chest Counter code (the clan tracker by taulen): ABCD-EFGH. Go to cwb . fyi and pick "Have a code? Join here" (signed in: "Add a clan with a code" in your account menu) within 72 hours. It works once.`
- Welcome: `Hi, and welcome to <clan>! TB Chest Counter is the clan tracker by taulen. Your code: ABCD-EFGH. Open cwb . fyi and choose "Have a code? Join here" (already signed in? "Add a clan with a code" in your account menu) in the next 72 hours. It can be used once. Need a new one? Reply "code".`
  (The clan name is left out when it looks like a link.)

## Who gets an answer (the safety rules)

Sending into a private chat is otherwise never allowed ([chat-digest.md](chat-digest.md));
these two and the answer to a member's own chat command
([chat-commands.md](chat-commands.md), same 1:1 check) are the only
exceptions, each narrowly scoped:

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
  → never resent. A refusal **"You are muted."** is not the player's: see below. A reserved send is marked `sending` with the code's hash in
  one transaction first, so a crash never sends twice.
- **`CHAT_SEND_DISABLED=1`** stops every send (and requests are recorded as
  ignored).
- **No code is ever logged or stored in plain text** — only its sha256.

## When the game mutes the scanner account

Too many messages and the game mutes the **scanner account** — ours, not the
players: every send to anyone comes back `EROR` "You are muted." until it
runs out (Nov 18 2026: about an hour, after 20 welcome codes in three
minutes; the game shows the countdown in its own chat). Then
([chat-send-state-repo.ts](../src/data/repositories/chat-send-state-repo.ts),
`chat_send_state` v131, per clan):

- **Everything stops at once** — code replies, welcome codes and the daily
  digest ([chat-digest.md](chat-digest.md)) — and nothing is tried again
  before the pause is over: trying while muted only adds to it. No scan is
  triggered for a waiting request meanwhile.
- **How long:** the app asks the chat service for the account's own mute in
  that chat (`myMuteInfo`: `GET /group_channels/<url>/mute/<user>` →
  `is_muted`, `end_at`, `remaining_duration`). If it gives the end, the pause
  runs to exactly then **plus 2 minutes**. If it says not muted (the game may
  mute outside the chat service's channel mutes) or can't be read, a set
  pause: **75 min**, then **3 h**, **12 h**, **24 h** for mutes in a row; a
  message that gets through starts that over. UNCONFIRMED LIVE: the first
  mute's log line (System page) keeps the refusal frame and the mute info as
  the chat service gave them — read it to learn which applied.
- **The player stays due:** the welcome goes back to `waiting` (reason
  `muted`) and a reply's request to `pending`, the code withdrawn and the try
  **not counted** — before this, three muted tries marked 10 players
  `skipped` for good (v131 put them back to waiting and started CWB's pause
  75 min after the last refusal).
- **Slower afterwards:** for a week after a mute, welcome codes go 20 minutes
  apart instead of 10 (`welcomeGapMs`) — the game may be stricter with an
  account it has flagged.
- The Clans → Account invites section says so while it lasts: "The game
  muted the scanner account's chat at … Nothing is sent until …".

## Joining (`/join`)

Codes are 8 characters from an alphabet without 0/O/1/I/L, single use, bound
to the clan and the player; the player must still be on the roster when it is
used. `/api/join/check` says what the code does, `/api/join/redeem` does it,
in one transaction:

| Visitor | Code's player | Result |
|---|---|---|
| signed out | has no account | **new**: choose a username (prefilled from the in-game name) and password. A username is taken in ANY case (`isUsernameTaken`, also enforced by `createUser`): when an account already holds the in-game name — an old hand-made one, most likely theirs — it is not prefilled, and the page names that account and says to sign in and use the code again, which **links** it. Before Nov 19 2026 the check was case-sensitive and clan 2's `balbine` (old) gained a twin `Balbine` this way |
| signed out | has an account | **recover**: choose a new password; every old session ends |
| signed out | linked to the superadmin | **superadmin-recover**: refused — a code never resets a superadmin's password (a shared game account must not open the site's top role); the check names no account |
| signed out | has an account, code made by hand by a clan admin | **manual-recover**: refused — sign in, or get a code from the scanner account; names no account |
| signed in | — | **add-clan**: the code's clan is added to the account |
| signed in, old account, own clan | — | **link**: the old account is linked; its role now follows the rank |
| signed in | linked to another account | refused — the superadmin can unlink |
| signed in | another player of yours is linked here | **add-player**: an alt (v130) |
| superadmin | not linked to another account | **link-player**: the player is linked to the superadmin and **nothing else** happens — no grant, no home, no role change |

Signed out, the way in is the sign-in page's "Have a code? Join here" (the
words the in-game message names). Signed in, it happens inside the app
([add-clan.js](../src/web/public/lib/add-clan.js)): **Add a clan with a code**
in the account menu, **+ Add a clan** at the bottom of the clan switcher (and
under a one-clan label in the phone's More sheet), and Home's line for an
unlinked account all open one dialog. It checks the code and says exactly
what it will do before anything happens ("Adds CWB · ChaosWithoutBorders to
your account as Kael Ironwood (Officer). Your role there: member." / "Links
your account to …"), or why it can't be used. Confirm redeems it with
`stay: true` — signed in, that keeps the session on its current clan (without
it, as on /join, the session lands on the code's clan) — then redraws the
switcher and offers **Switch to … now** or **Stay here**. The superadmin gets
the account-menu entry (it links its own players, "Links X to your account in
CWB. Your superadmin access does not change."); the switcher's **+ Add a clan**
stays hidden for it — it sees every clan already.

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
- **A superadmin may link its own players (code, account menu), and is never
  touched.** The scan keeps its link rows current (rank, name, on the roster)
  but never changes its role, grants, home or blocked state; a code never
  resets its password. Promoting an account to superadmin keeps its links.
  Its main player per clan drives its picture and "Playing as", and the
  Members board marks its players "You", like anyone's.

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
welcome_enabled_at, welcome_backlog_at), `user_game_links` (account ↔ player,
several per clan since v130 — alts; chat_user_id, rank, on_roster),
`user_clan_main` (v130: the player an account plays as in a clan), `chat_invite_requests`,
`chat_invite_welcomes`, `account_invite_codes` (sha256 only, kind
reply/welcome/manual; v132 `issued_by` for codes made by hand),
`chat_send_state` (v131: the last invite DM, a mute's pause and its count). Deleting a clan or a user clears them
([fk-delete-guards.test.ts](../tests/data/fk-delete-guards.test.ts)).
