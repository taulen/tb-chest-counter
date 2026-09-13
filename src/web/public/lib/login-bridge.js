// Shared in-app Total Battle login bridge. Streams a remote in-container
// browser into a canvas via WebSocket so the operator can sign in without
// leaving the page. Imported by both the Clans admin page (refresh login
// per clan) and the setup wizard (capture clan #1 auth during first-time
// setup). Server-side: src/web/login-bridge.ts.

import { apiPost } from './api.js';
import { normalizeWheelDelta } from './wheel.js';

// ---------- Panel markup ----------
//
// Returned as an HTML string so callers can drop it wherever it makes
// sense in their own DOM. The panel itself is rendered hidden — call
// startLoginSession(...) to open it.
//
// Options:
//   - modal: when true, the panel is tagged with .login-session-modal so
//     the shared stylesheet renders it as a centered, dimmed overlay (used
//     by the Clans page). Omitted on Setup, where the panel stays inline in
//     the natural document flow.
export function loginBridgePanelHTML({ modal = false } = {}) {
  const panelClass = `login-session-panel${modal ? ' login-session-modal' : ''} is-hidden`;
  return `
    <div id="loginSessionPanel" class="${panelClass}">
      <div class="login-session-card">
        <div class="login-session-card-header"><h2>Login session</h2></div>
        <div class="login-session-card-body">
          <div class="login-session-statusrow">
            <span id="loginSessionStatus" class="muted-copy"></span>
            <span class="muted-copy login-session-url" id="loginSessionUrl"></span>
          </div>
          <div id="loginSessionViewport" class="login-session-viewport">
            <canvas id="loginSessionCanvas" class="login-session-canvas" width="1280" height="800" tabindex="0"></canvas>
            <div id="loginSessionOverlay" class="login-session-overlay">Connecting...</div>
          </div>
          <p class="muted-copy login-session-hint">Click in the frame to type. Use the buttons below once you are fully in-game.</p>
          <div class="login-session-actions">
            <button class="btn btn-primary" data-action="login-session-save">I'm logged in — save session</button>
            <button class="btn" data-action="login-session-paste">Paste…</button>
            <button class="btn" data-action="login-session-reload">Reload page</button>
            <button class="btn" data-action="login-session-cancel">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ---------- Internal state ----------

let loginSessionState = null;
// Caller-supplied callback fired after a successful save. Lives at module
// scope so a single instance of the panel can serve both Clans and Setup
// without each having to track its own bridge state.
let onSavedCallback = null;

function setLoginSessionStatus(text) {
  const el = document.getElementById('loginSessionStatus');
  if (el) el.textContent = text || '';
}

function setLoginSessionOverlay(text) {
  const el = document.getElementById('loginSessionOverlay');
  if (!el) return;
  if (text) {
    el.textContent = text;
    el.classList.remove('is-hidden');
  } else {
    el.classList.add('is-hidden');
  }
}

function showLoginSessionPanel(show) {
  const panel = document.getElementById('loginSessionPanel');
  if (!panel) return;
  panel.classList.toggle('is-hidden', !show);
  // Drive the modal fade/slide entrance: reveal (display) first, then flip
  // .is-visible on the next frame so the transition has a starting state to
  // animate from. Inline (non-modal) usage ignores .is-visible entirely.
  if (show) {
    requestAnimationFrame(() => {
      const el = document.getElementById('loginSessionPanel');
      if (el) el.classList.add('is-visible');
    });
  } else {
    panel.classList.remove('is-visible');
  }
}

// Release the socket, its listeners and the canvas.
//
// `keepPanel` leaves the panel on screen so the user can read why it
// stopped — the status line lives *inside* the panel, so hiding it also
// hides the explanation. Used for unexpected endings (the remote browser
// crashed); ordinary save/cancel still closes up.
function tearDownLoginSession(reason, { keepPanel = false } = {}) {
  const state = loginSessionState;
  loginSessionState = null;

  if (state) {
    const { socket, listeners } = state;
    if (listeners) {
      listeners.forEach(({ target, type, handler, options }) => {
        try { target.removeEventListener(type, handler, options); } catch {}
      });
    }
    if (socket && socket.readyState <= 1) {
      try { socket.close(); } catch {}
    }
  }

  // Panel handling runs even when there was no live state, so a Cancel
  // click after an already-dead session still closes the panel instead of
  // bailing out at the top and leaving it stuck open.
  if (!keepPanel) {
    const canvas = state?.canvas ?? document.getElementById('loginSessionCanvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    showLoginSessionPanel(false);
  }
  setLoginSessionStatus(reason || '');
}

function modifierBits(ev) {
  // CDP modifier flags: Alt=1, Ctrl=2, Meta=4, Shift=8
  let m = 0;
  if (ev.altKey) m |= 1;
  if (ev.ctrlKey) m |= 2;
  if (ev.metaKey) m |= 4;
  if (ev.shiftKey) m |= 8;
  return m;
}

function mouseButtonName(button) {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

// ---------- Public API ----------

/**
 * Open the bridge for a clan and stream its remote browser into the
 * panel canvas. Options:
 *   - onSaved: fn(saveResponse) — called after the user clicks
 *     "I'm logged in — save session" and the server reports success.
 *
 * The Clans page renders the panel as a centered modal overlay
 * (loginBridgePanelHTML({ modal: true })), so it needs no per-clan DOM
 * docking; the Setup wizard renders it inline in its natural place. Either
 * way the panel is a singleton, so opening it just reveals it in place.
 */
export async function startLoginSession(clanId, options = {}) {
  onSavedCallback = typeof options.onSaved === 'function' ? options.onSaved : null;

  if (loginSessionState) {
    setLoginSessionStatus('Session already open.');
    showLoginSessionPanel(true);
    return;
  }
  const body = Number.isFinite(clanId) ? { clanId } : {};

  // Reveal the panel BEFORE the slow API call. The server has to spin
  // up Chromium + (on Linux) Xvfb the first time a clan's profile dir
  // is used, which routinely takes 20-40 seconds. Without immediately-
  // visible status the user thinks the click did nothing.
  showLoginSessionPanel(true);
  setLoginSessionOverlay('Launching browser…');
  setLoginSessionStatus('Launching browser… this can take 30+ seconds on first run.');

  try {
    const res = await apiPost('/admin/login-session/start', body);
    if (res.error) {
      setLoginSessionStatus('❌ ' + res.error);
      setLoginSessionOverlay(res.error);
      return;
    }
    setLoginSessionStatus('Connecting to remote browser…');
    setLoginSessionOverlay('Connecting…');
    attachLoginSessionSocket(res.width || 1280, res.height || 800);
  } catch (err) {
    const msg = String(err);
    setLoginSessionStatus('❌ ' + msg);
    setLoginSessionOverlay(msg);
  }
}

function attachLoginSessionSocket(width, height) {
  const canvas = document.getElementById('loginSessionCanvas');
  if (!canvas) return;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${wsProto}//${window.location.host}/api/admin/login-session/ws`);
  const listeners = [];
  const addListener = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push({ target, type, handler, options });
  };

  loginSessionState = { socket, listeners, canvas, width, height };

  const eventCoords = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * width;
    const y = ((ev.clientY - rect.top) / rect.height) * height;
    return { x: Math.max(0, Math.min(width, Math.round(x))), y: Math.max(0, Math.min(height, Math.round(y))) };
  };

  // CDP's `buttons` bitmask (1=left, 2=right, 4=middle) is identical to the
  // DOM's MouseEvent.buttons, so forward that straight through. Tracking it
  // by hand as `1 << ev.button` was wrong: DOM MouseEvent.button numbers
  // middle as 1 and right as 2, so a right-drag arrived at the game as a
  // middle-button drag and vice versa.
  const sendJSON = (payload) => {
    if (socket.readyState !== 1) return;
    try { socket.send(JSON.stringify(payload)); } catch {}
  };

  socket.binaryType = 'arraybuffer';

  // ---- Frame decode pipeline ----
  //
  // Frames arrive as raw JPEG in binary messages (control messages are
  // text JSON). Two rules make the difference between "video" and "slide
  // show" here, and neither is about bandwidth:
  //
  //  1. Only ever ONE decode in flight, and always of the NEWEST frame.
  //     The old code did `new Image()` per frame and drew on img.onload,
  //     so N decodes ran concurrently and landed in completion order —
  //     frames drawn out of order, which looks exactly like stutter. Any
  //     frame that arrives while we're busy replaces the pending one
  //     instead of queueing: a live stream has no use for a stale frame,
  //     and queueing them is what turns a slow link into growing lag.
  //  2. createImageBitmap() instead of Image + data: URL. It decodes off
  //     the main thread and takes the bytes directly — no ~250 KB base64
  //     string to build, and no data-URL reparse per frame.
  let pendingFrame = null;
  let decoding = false;
  const canDecodeBitmap = typeof window.createImageBitmap === 'function';

  const drawFrames = async () => {
    if (decoding) return;
    decoding = true;
    try {
      while (pendingFrame) {
        const bytes = pendingFrame;
        pendingFrame = null;
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (typeof bitmap.close === 'function') bitmap.close();
        setLoginSessionOverlay('');
      }
    } catch {
      // A corrupt/truncated frame must not kill the stream — the next one
      // repaints the whole canvas anyway.
    } finally {
      decoding = false;
    }
  };

  // Fallback for anything without createImageBitmap: same newest-frame-wins
  // discipline, via a single reused Image and a blob URL.
  const drawFrameFallback = (bytes) => {
    if (decoding) { pendingFrame = bytes; return; }
    decoding = true;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    const img = new Image();
    const done = () => {
      URL.revokeObjectURL(url);
      decoding = false;
      const next = pendingFrame;
      pendingFrame = null;
      if (next) drawFrameFallback(next);
    };
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setLoginSessionOverlay('');
      done();
    };
    img.onerror = done;
    img.src = url;
  };

  socket.onopen = () => {
    setLoginSessionStatus('Live — interact below.');
  };
  socket.onmessage = (ev) => {
    // Binary = screencast frame. Text = JSON control message.
    if (typeof ev.data !== 'string') {
      if (canDecodeBitmap) {
        pendingFrame = ev.data;
        void drawFrames();
      } else {
        drawFrameFallback(ev.data);
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }
    if (msg.kind === 'url' && typeof msg.url === 'string') {
      const urlEl = document.getElementById('loginSessionUrl');
      if (urlEl) urlEl.textContent = msg.url;
    } else if (msg.kind === 'ready') {
      const urlEl = document.getElementById('loginSessionUrl');
      if (urlEl) urlEl.textContent = msg.url || '';
      // The server starts from a guess and then adapts to what the link
      // actually carries, so surface where it landed and why — a deliberately
      // frugal stream should be explained rather than mysterious.
      const quality = typeof msg.quality === 'string' ? msg.quality : '';
      setLoginSessionStatus(quality ? `Live (${quality}) — interact below.` : 'Live — interact below.');
    } else if (msg.kind === 'quality' && typeof msg.quality === 'string') {
      // Mid-session step up or down on the quality ladder.
      setLoginSessionStatus(`Live (${msg.quality}) — interact below.`);
    } else if (msg.kind === 'fatal') {
      // The remote browser died (crash, OOM, exit). Nothing we send can
      // land any more, so stop rather than stream input into a corpse.
      const text = typeof msg.message === 'string' ? msg.message : 'The remote browser stopped.';
      tearDownLoginSession('❌ ' + text, { keepPanel: true });
      setLoginSessionOverlay(text);
    }
  };
  socket.onerror = () => {
    setLoginSessionOverlay('Connection error');
  };
  socket.onclose = () => {
    if (loginSessionState && loginSessionState.socket === socket) {
      tearDownLoginSession('Disconnected.');
    }
  };

  // Mouse forwarding.
  //
  // mousemove is coalesced to one send per animation frame. A mouse moving
  // across the canvas fires well over 100 events/second, and every one of
  // them used to become its own WebSocket message and its own CDP
  // round-trip into the remote browser — pure overhead (the game can't
  // react faster than it renders), and the reason a browser hiccup showed
  // up as ~100 identical relay warnings inside two seconds. One position
  // per frame is all the remote page can use.
  let pendingMove = null;
  let moveFrame = 0;
  const flushMove = () => {
    moveFrame = 0;
    if (!pendingMove) return;
    sendJSON(pendingMove);
    pendingMove = null;
  };
  addListener(canvas, 'mousemove', (ev) => {
    const { x, y } = eventCoords(ev);
    pendingMove = {
      kind: 'mouse', type: 'mousemove', x, y,
      buttons: ev.buttons, modifiers: modifierBits(ev),
    };
    if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
  });
  // A click, release or wheel tick carries its own coordinates, so any
  // queued move is both redundant and out of date — sending it after would
  // yank the remote cursor backwards.
  const dropPendingMove = () => {
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    pendingMove = null;
  };

  addListener(canvas, 'mousedown', (ev) => {
    ev.preventDefault();
    canvas.focus();
    dropPendingMove();
    const { x, y } = eventCoords(ev);
    sendJSON({
      kind: 'mouse', type: 'mousedown', x, y,
      button: mouseButtonName(ev.button), buttons: ev.buttons,
      modifiers: modifierBits(ev), clickCount: 1,
    });
  });
  addListener(canvas, 'mouseup', (ev) => {
    ev.preventDefault();
    dropPendingMove();
    const { x, y } = eventCoords(ev);
    sendJSON({
      kind: 'mouse', type: 'mouseup', x, y,
      button: mouseButtonName(ev.button), buttons: ev.buttons,
      modifiers: modifierBits(ev), clickCount: 1,
    });
  });
  addListener(canvas, 'contextmenu', (ev) => ev.preventDefault());
  addListener(canvas, 'wheel', (ev) => {
    ev.preventDefault();
    dropPendingMove();
    const { x, y } = eventCoords(ev);
    // Normalize units and keep the sign — see lib/wheel.js. Previously these
    // deltas were negated (reversing scroll) and forwarded in whatever unit
    // the browser chose, so a line-mode notch asked the remote page to scroll
    // 3 pixels.
    const { deltaX, deltaY } = normalizeWheelDelta(ev, height);
    sendJSON({
      kind: 'mouse', type: 'wheel', x, y,
      deltaX, deltaY,
      modifiers: modifierBits(ev),
    });
  }, { passive: false });

  const isPrintable = (key) => typeof key === 'string' && key.length === 1;

  const sendPastedText = (text) => {
    if (!text) return;
    for (const ch of text) {
      sendJSON({ kind: 'key', type: 'char', text: ch });
    }
  };

  const tryPasteFromClipboard = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const text = await navigator.clipboard.readText();
        if (text) {
          sendPastedText(text);
          return true;
        }
      }
    } catch {
      // Permission denied or unsupported — fall through to prompt
    }
    const fallback = window.prompt('Paste text to send to the remote browser:');
    if (fallback) sendPastedText(fallback);
    return false;
  };

  addListener(canvas, 'keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
      ev.preventDefault();
      void tryPasteFromClipboard();
      return;
    }
    ev.preventDefault();
    sendJSON({
      kind: 'key', type: 'keydown',
      key: ev.key, code: ev.code,
      // `keyCode` is deprecated in the DOM but is the Windows virtual key
      // code CDP needs, and it is the ONLY thing that makes Backspace,
      // Delete, the arrows and Home/End do anything remotely — Chromium
      // dispatches those commands from the VK code, never from `key`.
      keyCode: ev.keyCode || undefined,
      location: ev.location || undefined,
      repeat: ev.repeat || undefined,
      text: isPrintable(ev.key) && !ev.ctrlKey && !ev.metaKey ? ev.key : undefined,
      modifiers: modifierBits(ev),
    });
  });
  addListener(canvas, 'keyup', (ev) => {
    ev.preventDefault();
    sendJSON({
      kind: 'key', type: 'keyup',
      key: ev.key, code: ev.code,
      keyCode: ev.keyCode || undefined,
      location: ev.location || undefined,
      modifiers: modifierBits(ev),
    });
  });
  addListener(canvas, 'paste', (ev) => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData('text') || '';
    sendPastedText(text);
  });

  loginSessionState.pasteHelper = tryPasteFromClipboard;
}

export async function saveLoginSession() {
  setLoginSessionStatus('Saving session…');
  try {
    const res = await apiPost('/admin/login-session/save', {});
    if (res.error) {
      setLoginSessionStatus('❌ ' + res.error);
      return;
    }
    tearDownLoginSession(res.message || 'Session saved.');
    setLoginSessionStatus('✅ ' + (res.message || 'Session saved.'));
    if (onSavedCallback) {
      try { onSavedCallback(res); } catch {}
      onSavedCallback = null;
    }
  } catch (err) {
    setLoginSessionStatus('❌ ' + String(err));
  }
}

export async function cancelLoginSession() {
  setLoginSessionStatus('Closing…');
  try {
    await apiPost('/admin/login-session/cancel', {});
  } catch {
    // Best-effort
  }
  tearDownLoginSession('Cancelled.');
  onSavedCallback = null;
}

export function reloadLoginSession() {
  if (!loginSessionState) return;
  const { socket } = loginSessionState;
  if (socket && socket.readyState === 1) {
    try { socket.send(JSON.stringify({ kind: 'reload' })); } catch {}
  }
}

export async function pasteIntoLoginSession() {
  if (!loginSessionState) return;
  const { canvas, pasteHelper } = loginSessionState;
  if (canvas) canvas.focus();
  if (typeof pasteHelper === 'function') {
    await pasteHelper();
  }
}

/**
 * Wire data-action="login-session-*" buttons inside `root` to the
 * bridge functions. The setup page uses this because it doesn't share
 * the main app's central dispatcher. Clans relies on the dispatcher in
 * app.js and skips this.
 */
export function bindLoginBridgeActions(root) {
  if (!root || typeof root.addEventListener !== 'function') return;
  root.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute('data-action');
    if (action === 'login-session-save') return void saveLoginSession();
    if (action === 'login-session-cancel') return void cancelLoginSession();
    if (action === 'login-session-reload') return reloadLoginSession();
    if (action === 'login-session-paste') return void pasteIntoLoginSession();
  });
}
