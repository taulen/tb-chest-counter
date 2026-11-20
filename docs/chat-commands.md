# Chat commands

Members message the clan's **scanner account** one word in the game and get
their numbers back: the site's Members board, goal and pace, read where they
play. The idea comes from tbclanportal's chat bot (Nov 2026); only the
commands we have data for are here: no CP runs, penalties, notes,
announcements or surveys, and no troop-tier codes (we read tiers from
research).

Code: [scheduler/chat-commands.ts](../src/scheduler/chat-commands.ts) (words,
guards, limits, replies, answering),
[scheduler/chat-command-texts.ts](../src/scheduler/chat-command-texts.ts) (the
replies' words in en/es/fr/ru/de),
[chat-command-repo.ts](../src/data/repositories/chat-command-repo.ts),
[game-protocol/chat-send.ts](../src/game-protocol/chat-send.ts)
(`sendCommandReply`, `sendGroupCommandReply`, the length checks),
[routes/clans/chat-commands.ts](../src/web/routes/clans/chat-commands.ts),
[pages/clan-chat-commands.js](../src/web/public/pages/clan-chat-commands.js).
Tables (v135): `chat_command_settings`, `chat_command_requests`,
`chat_channels.max_length`.

## The commands

| Word | Answer |
|---|---|
| `me` | This week: rank, points, chests, today, the goal line, last week, Might / Guards / Gold Pass |
| `points` (`crypt`) | This week's points, rank, today, the goal line |
| `chests` | This week's chests, rank by chests, today |
| `top` (`leaderboard`, `ranking`) | The top 10 this week, points (chests), and where the asker stands below it |
| `progress` | The last 4 closed weeks (points, rank, goal ✓/✗ judged by **that week's** goal) and this week so far; weeks before the player joined say so |
| `events` (`calendar`) | Events running now (time left) and coming up (time until), from the event calendar feed |
| `help` (`commands`) | The list; `code` when account invites are on; `missing` for leaders |
| `missing` | **Leader / Superior only** (`rankRole`): who is behind pace this week, furthest behind first — the Members board's red |

- **The whole message is one word**, any case, a leading `!` / `/` and
  trailing punctuation allowed. "what are my points" is not a command, and
  anything that isn't a command gets **no reply at all**.
- A few words in the site's other languages work too (`puntos`, `очки`,
  `Punkte`, `classement`, …; `ALIASES`) and answer in that language. Short
  words a player might just say (`yo`) are left out. Never an invite keyword
  (`code`, `invite`, `tracker`, …): those are [account-invites.md](account-invites.md)'s.
- **Language:** the command word's language, else (private chat only) the
  player's site account's, else the clan's chat digest language, else English.
- The figures are the site's: `queryLeaderboard` over the clan's game week
  ([clan-week.md](clan-week.md)), the goal from `resolveWeeklyGoal` +
  `weeklyGoalForDays` (history — [performance-page.md](performance-page.md#weekly-goal-history)),
  the pace mark as the board's (goal × share of the week gone). Glyph AND words
  for every state: `reached ✓`, `on pace ◐`, `behind pace ↓`.

## Where it answers

1. **Private chat** (Clans → Chat commands → *Answer chat commands*, off by
   default): the reply goes into the 1:1 chat the player wrote in —
   `assertInviteChannel`, the same check as an invite code: a `whisper`
   holding exactly the scanner account and that player.
2. **The digest's group chat** (*Also answer in CWB • Carter*, its own switch,
   off by default, only while 1 is on): commands written in the group chat the
   daily digest goes to ([chat-digest.md](chat-digest.md) — its picked
   `channel_url`) are answered **there, for everyone in it**.
   `assertCommandGroupChannel`: `assertPostableChannel` (never the clan chat,
   the kingdom chat, a private chat or an unnamed chat) AND exactly that url —
   never any other group chat. While it is on, the chat sync lists the named
   group chats too, keeps only that one, and reads it **forward only** from the
   switch-on (at most 3 h back); its history is never backfilled. The site's
   chat pages serve only the clan chat, so its lines are never shown.
   **A code is never posted there**: `code` (or any invite keyword) written in
   the group chat is answered with the code in the asker's **private** chat
   with the scanner — the stored 1:1 chat, else one opened as a welcome code
   opens it — with every invite rule ([account-invites.md](account-invites.md)).
   `help` in the group says so ("sent to you privately").

## Who gets an answer

- Commands switched on, the message sent after the switch-on (the group's own
  switch-on for the group) and **within 3 h** (`MAX_COMMAND_AGE_MS`; older
  ones are dropped `too-old`).
- The sender is **on the clan's roster**; the sender's chat account is the one
  that player writes from (`chatAccountMismatch`, as for invites — a mismatch
  raises a warning).
- `missing` from anyone below Superior gets "Only clan leaders can use
  “missing”."
- Nothing while the game has the scanner account **muted** (the pause in
  `chat_send_state` — a "You are muted." refusal pauses codes, the digest and
  commands alike; the command waits, its try not counted).
  NOTE: a clan muting the scanner in its group chat looks the same to us, so
  it pauses everything too.
- `CHAT_SEND_DISABLED=1` answers nothing.

## Limits (the account was muted on Nov 18 2026 for 20 messages in 3 min)

- The **same command again within 10 min** (`REPEAT_WINDOW_MS`) gets nothing,
  `repeat`: the answer is in the chat. Per player and chat; in the group chat,
  `top`, `events`, `help`, `missing` (`SHARED_COMMANDS`) repeat for **anyone**
  — the answer is right above.
- A player: **10 replies an hour** (`PLAYER_MAX_PER_HOUR`), then `player-limit`.
- A run (each minute): **3 replies** (`COMMAND_REPLIES_PER_RUN`), 4 s apart,
  one per player; the rest wait for the next minute.
- The clan: **30 replies an hour** (`CLAN_MAX_PER_HOUR`); the group chat:
  **one a run, 12 an hour** (`GROUP_MAX_PER_HOUR`). Over a budget, commands
  wait (until 3 h old).
- Command replies don't push welcome codes back (they keep their own
  `last_send_at` gap).

## Message length

Every reply is **one message, never split**, no longer than the digest's
ceiling (**898 characters / 1,114 UTF-8 bytes**, `MAX_COMMAND_REPLY_CHARS`)
or the chat's own `max_length_message` when that is smaller (stored per
channel as `chat_channels.max_length` from the channel listing; every chat
reported 1000 in Nov 2026). The builders fit to it: lists drop lines from the
bottom and end with "… and N more"; anything still too long is cut. The send
checks it again and refuses (nothing sent) a text past it. Account-invite
messages (400) are checked against the channel's limit the same way.

## When

The chat is read every minute (chat-capture.ts). A reply goes out **within a
minute** while the clan's last scan left its game session kept (a chat token
needs it — message 414). The chat session (reading) survives a restart
(`chat-session.json`), the game session does not: so after a restart a
waiting command asks the scan loop for a scan of that clan, exactly like a
code request (`maybeScanForChatReplies` → `scanForChatReply`: the clan's turn
on its lane, at most once per clan every 10 minutes, only while no session is
kept). The scan answers it and keeps a session for the next ones. Until Nov 20
2026 commands didn't do this, and the first `help` after a deploy sat at
"Waiting to send" until CWB's scheduled scan.

## Outcomes

Every command message is recorded once (`chat_command_requests`, unique per
clan + channel + message), answered or not. A reply is reserved (`sending`,
`sent_at` stamped) before it goes out: `sent`; `refused` (nothing went out) →
tried again, three times at most, then `failed`; `unknown` (no answer) →
**never resent**. Clans → Chat commands lists the latest 25 with why each
wasn't answered.
