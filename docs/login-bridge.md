# Login bridge

The login bridge streams an in-container Chromium into the admin UI over a
WebSocket. Two uses, both interactive:

1. **Signing a clan in** with email + password, then capturing the resulting
   cookies as that clan's `storage-state.json` for the scanner to replay.
2. **Operating the account** — several admins share one game account and use the
   bridge from time to time to perform simple in-game actions.

Server: [`src/web/login-bridge.ts`](../src/web/login-bridge.ts) plus the modules
under [`src/web/login-bridge/`](../src/web/login-bridge/).
Client: [`src/web/public/lib/login-bridge.js`](../src/web/public/lib/login-bridge.js).

---

## What makes the session interactive

Not a headed browser. Four things:

| Piece | Mechanism |
|---|---|
| Picture | CDP `Page.startScreencast` → JPEG frames → binary WebSocket messages |
| Input | CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` |
| Session continuity | Playwright persistent profile per clan |
| Full browser features | `channel: 'chromium'` (never headless-shell) |

All four work identically in Chromium's **new headless** mode, which is why the
bridge no longer needs a display server. See "Display modes" below.

---

## Display modes — `LOGIN_BRIDGE_DISPLAY`

| Value | Meaning |
|---|---|
| `headless` (default) | Chromium's **new headless** — the full browser rendering offscreen. No X server. **The only mode where WebGL can reach the iGPU**, because a hardware-backed surface comes from the DRM render node, not from a window. |
| `xvfb` | The old headed-on-virtual-X path. Escape hatch only. Xvfb is a pure software framebuffer, so this mode **can never be GPU-accelerated** — GPU is forced off and a warning is logged. |

`channel: 'chromium'` is passed unconditionally. Two load-bearing reasons: it is
the only GPU-capable build, and with `headless: true` it selects new headless
rather than `chromium-headless-shell` — a stripped binary that is not a sound
host for a session a human drives by hand.

### Why Xvfb was there, and why it isn't the default any more

Do not reintroduce it without reading this.

- `1af9697` (Apr 2026) went headed under Xvfb because headless captured ~15
  cookies instead of ~55 during **Google OAuth** session-sync.
- `c431456` (Jun 2026) retracted the cookie-count concern entirely: the only
  cookie that matters is `PTBHSSID`, and a 16-cookie capture "has scanned fine
  for months".
- The Google OAuth flow itself was abandoned — login is email + password.

So the justification died twice over. "Headless" in that April commit also meant
**headless-shell**, a genuinely degraded binary; new headless is not that.

---

## GPU rendering — `LOGIN_BRIDGE_GPU`

Unset follows `SCANNER_GPU`; `0`/`1` decides independently. The flag set lives in
[`src/browser/gpu.ts`](../src/browser/gpu.ts), shared with the scanner so the two
launch sites cannot drift apart. Host setup: [igpu-passthrough.md](igpu-passthrough.md).

Software-rendering a 3D WebGL canvas is the hard ceiling on bridge framerate.
Screencast tuning cannot lift it — the screencast can only forward frames the
browser already drew.

**The failure mode to know about:** when the GPU path is broken, WebGL context
creation does not error — it *never completes*. That presents as the panel stuck
on "Launching browser…", because the game is a WebGL app and its own context
creation stalls the same way for the whole navigation timeout.

Handled by verifying before navigating:

1. `logWebglRenderer()` probes a WebGL context on the blank start page,
   time-boxed at 8s. (Probing *after* loading the game means a second context on
   a page that already holds one — slow enough to look like a hang by itself.)
2. It returns `hardware` | `software` | `stalled` | `unknown`.
3. On `stalled`, the bridge discards that browser and relaunches
   software-rendered. Slower beats a session that never opens.

A healthy start logs the renderer string:

```
GPU mode ON — WebGL renderer: "ANGLE (Intel, Vulkan 1.3.230 (Intel(R) UHD Graphics 770 ...), Intel open-source Mesa driver)"
```

---

## Adaptive stream quality

Frames go out as **raw JPEG in binary WebSocket messages** (25% smaller than
base64-in-JSON, and no multi-hundred-KB string per frame on either end). Text
messages are JSON control messages; binary is always a frame.

Quality is **not** chosen from the client's IP. That cannot work:

- IPv6 has no NAT, so a client on the same LAN holds a globally-routable address
  (e.g. `2a0d:9c42:…`). "Not in a private range" says nothing about locality.
- Matching the client against our own interface subnets doesn't help either —
  we run in Docker, so our interfaces are the bridge network (`172.x`).
- This deployment is behind Cloudflare, so a LAN client measures ~12ms RTT
  because packets hairpin out and back.

Instead there is a four-rung ladder (`STREAM_LADDER` in
[`link-quality.ts`](../src/web/login-bridge/link-quality.ts)) from
(quality 80, every frame) down to (quality 45, every 5th), and a closed loop:

- **Starting rung** from measured WebSocket ping RTT, with loose boundaries
  (30 / 80 / 200 ms). A private address short-circuits to the top rung. Being
  wrong is cheap — the loop corrects in seconds — so it errs generous.
- **Every 2s**, compare frames sent against frames dropped to socket
  backpressure: step **down** above a 20% drop rate, step **up** after 3
  consecutive drop-free windows. One rung at a time, bounded by the ladder.
- Re-issuing `Page.startScreencast` updates a live stream in place; that is what
  makes mid-session retuning possible.

Some dropping is *healthy* — it is how the stream tracks real capacity — hence a
threshold well clear of zero. "A few drops" holds station rather than banking
progress toward stepping up, so a marginal link does not oscillate.

`LOGIN_BRIDGE_STREAM_PROFILE=local|remote` pins a rung and **disables
adaptation** rather than fighting the operator.

### Other things that shaped the pipeline

- **Ack before deliver.** Chromium will not capture the next frame until the
  current one is acked, so the ack loop *is* the flow control and framerate =
  1/(per-frame round trip). Doing any work before acking subtracts from the
  framerate on every frame.
- **One decode in flight, newest frame wins** (client). `new Image()` per frame
  meant N concurrent decodes landing in *completion* order — frames drawn out of
  sequence, which looks exactly like stutter. `createImageBitmap()` decodes off
  the main thread; a stale frame is useless to a live stream, and queueing them
  is what turns a slow link into growing lag.
- **mousemove is coalesced to one send per animation frame.** A mouse crossing
  the canvas fires 100+ events/second, each becoming its own CDP round trip.
- **Button masks come from `MouseEvent.buttons`, not `1 << ev.button`.** The DOM
  `buttons` bitmask is already identical to CDP's (1=left, 2=right, 4=middle),
  whereas `button` numbers middle as 1 and right as 2 — building the mask by
  hand turned a right-drag into a middle-drag.
- **Every key event carries `windowsVirtualKeyCode`, from the client's
  `ev.keyCode`.** Chromium runs editing and navigation commands off the VK code,
  not off the `key` string, so a keydown with `key: 'Backspace'` and no VK code
  arrives, fires no command and vanishes — Backspace and Delete were dead in the
  bridge for exactly this reason while typing worked, because a printable key
  carries `text` and needs no command. Relatedly, `type: 'keyDown'` promises a
  character event will follow, so a key with no text goes as `rawKeyDown`.
- **Wheel deltas are normalized to pixels and passed through with their sign
  unchanged** — see [`lib/wheel.js`](../src/web/public/lib/wheel.js). CDP always
  interprets its deltas as pixels, but `WheelEvent.deltaY` is only in pixels when
  `deltaMode` is PIXEL; a LINE-mode notch is about ±3, which forwarded raw asks
  the remote page to scroll 3px. CDP's `mouseWheel` also uses the *same* sign
  convention as the DOM (positive scrolls down), so negating reverses scrolling.
  Both mistakes were present at once, which is why scrolling appeared dead.

---

## `LOGIN_BRIDGE_VIEWPORT`

Resolution the browser **renders** at (default `1280x800`; the client scales to
fit). Matters most when WebGL is on the CPU: software rasterising is per-pixel
work, so `960x600` is ~45% fewer pixels and renders correspondingly faster, at
the cost of a softer picture.

---

## Chromium profile locks

Chromium writes `SingletonLock` into the profile dir as a symlink whose *target*
is the literal text `<hostname>-<pid>`. On an unclean exit it survives in the
mounted volume, and since **Docker assigns a new container hostname on every
recreate**, Chromium decides the profile is held by a process on another machine
and refuses to break the lock — by design, since it cannot verify a process on a
different host is dead. One hard kill becomes a permanent crash loop:

```
The profile appears to be in use by another Chromium process (24) on another
computer (f174855942cd)
```

[`src/browser/profile-lock.ts`](../src/browser/profile-lock.ts) clears the
singleton set before every launch, in both the scanner and the bridge (they use
separate profile dirs — see [`clan-paths.ts`](../src/config/clan-paths.ts)).
Only locks that **provably** cannot be live are removed: a different hostname, or
this hostname with a dead pid. A lock naming this host with a running pid is left
alone and warned about.

`existsSync()` is useless on these files — the target is not a real path, so they
are dangling symlinks and `existsSync`, which follows links, reports `false` for a
file that is definitely there. Use `unlink()` on the link itself.

---

## Lifecycle and safety rails

| Rail | Value | Why |
|---|---|---|
| Browser launch timeout | 90s | A cold per-clan profile genuinely takes 30s+, but unbounded means a spinner forever. |
| Renderer probe timeout | 8s | See the GPU stall above. |
| Idle teardown | 3 min after socket close | An abandoned session is a bandwidth + RAM leak. |
| Max session | 30 min | A forgotten connected tab must not stream the live game indefinitely. |
| Frame backpressure | skip above 512 KB queued | Newest frame wins; queueing adds latency. |
| Liveness probe | 10s | Gate before a session is declared active — see below. |
| Teardown step | 5s screencast/CDP, 15s browser close | Nothing on the exit path may hang. |
| Storage-state read | 20s | A wedged browser must not hang the save request. |

The bridge **pauses the scan loop** while open and resumes it from a teardown
hook, so every exit path — save, cancel, idle, max-session, browser death —
resumes the scanner.

### Surviving a browser that dies (or wedges)

The bridge's browser is the most memory-hungry thing in the container, so it is
the first casualty of memory pressure. Four separate things have to hold for
that to cost nothing more than one failed session. **All four were once broken
at the same time**, which is what produced a bridge that reported itself busy
for 30 minutes after its browser had already died.

**1. Death is noticed from the moment the browser exists.**
`page.on('crash'|'close')` and `context.on('close')` are wired immediately after
launch, *before* the game is navigated to. That ordering is load-bearing:
Playwright emits those events once, when they happen, so listeners added
afterwards never hear about a page that is already dead — and loading the game
is precisely when an OOM kill lands. Each listener captures the current *launch
generation* and ignores stale events, so the browser `start()` deliberately
discards on the GPU-stall path, and every browser our own teardown closes,
cannot masquerade as a crash.

**2. A session is not "active" until the browser is proven to answer.**
`start()` gates on `context.cookies()` behind a deadline before publishing the
session. A live browser answers in milliseconds; a dead one rejects; a wedged
one hangs and the deadline reports it. Anything but a clean answer takes the
normal failure path, which tears down and returns a real message to the
operator. Deliberately **not** `page.evaluate()` — that can reject with
"execution context was destroyed" simply because the game navigated, failing a
perfectly healthy session.

**3. Teardown's state transition is synchronous; only the cleanup is awaited.**
Every field that makes the bridge look occupied is cleared *before* anything is
awaited, and each release step is deadline-bounded. It used to be the other way
round — `this.context` was nulled only after `await context.close()` returned,
with the re-entrancy latch held for the duration. A browser that is alive but
wedged answers `close()` with neither a resolve nor a reject, so that await
never returned, and with it: `isActive()` stayed true, every later `cancel()`
returned instantly as a no-op against the latch, `start()` refused with "Login
session already active", and the max-session timer that might have rescued it
had already been cleared on the way in. Only restarting the container cleared
it. A hung close now costs a leaked process and nothing else.

**4. A browser that outlives its close deadline is SIGKILLed.**
Via `killProfileOwner()` in [`profile-lock.ts`](../src/browser/profile-lock.ts),
which reads the owning pid out of `SingletonLock`. Leaving it alive is worse
than a leaked process: it still holds the profile lock with a *live pid on this
host*, which is the one case `clearStaleProfileLocks` refuses to break, so the
next session would fail with "profile appears to be in use" — a wedge that
outlives the session that caused it.

Beyond those four: `start()` **reclaims** rather than refuses if it somehow
still finds a dead browser (page closed, browser disconnected, or a death
already reported), and `attachSocket()` owns its own failures — the caller
invokes it as `void attachSocket(...)`, so an escaping rejection would be
unhandled and leave the client on "Connecting…" forever.

A death is reported exactly once, and the client is told via a `fatal` message.

Repeated identical warnings from the relay and screencast are coalesced through
[`log-throttle.ts`](../src/utils/log-throttle.ts): one immediate line plus one
`repeated N×` summary per window. The System page's warning buffer holds only 20
entries, so an unthrottled input flood evicts everything an admin needed to see.
