# Browsers

Two Chromium instances, each with its own persistent profile per clan (see [clan-paths.ts](../src/config/clan-paths.ts)) — never share a profile dir, Playwright can't open one twice.

- **Scanner** — [src/browser/launcher.ts](../src/browser/launcher.ts), headless.
- **Login bridge** — [src/web/login-bridge.ts](../src/web/login-bridge.ts): an interactive session streamed to the admin UI over a WebSocket, used both to sign a clan in (email + password) and for several admins to operate the shared game account. **Full reference: [docs/login-bridge.md](login-bridge.md)** — read it before changing the bridge.

Both launch through the shared GPU recipe in [src/browser/gpu.ts](../src/browser/gpu.ts) and the profile-lock cleanup in [src/browser/profile-lock.ts](../src/browser/profile-lock.ts). Things worth knowing before touching either:

- **`channel: 'chromium'` selects Chromium's NEW headless** (a full browser rendering offscreen). The default `headless: true` uses `chromium-headless-shell`, which has **zero GPU support** and is feature-poor. New headless is also what replaced the bridge's old headed-under-Xvfb setup — Xvfb is a software framebuffer and can never be GPU-accelerated.
- **A broken GPU path does not error — WebGL context creation never completes.** Anything that needs a context (i.e. the game) then hangs. Always verify with `logWebglRenderer()` before navigating somewhere heavy, and keep the timeout on it.
- **Env toggles are only visible to the process if they're in `docker-compose.yml`'s `environment:` list.** Compose uses `.env` for `${...}` interpolation inside the file, not to pass variables into the container. A new toggle that isn't listed there silently does nothing.
- **Clear stale Chromium singleton locks before launching.** They survive an unclean exit in the mounted volume, and since Docker assigns a new container hostname on every recreate, Chromium refuses to break them — turning one hard kill into a permanent crash loop. `fs.existsSync()` cannot see them: they're dangling symlinks.
- **Playwright puts NO timeout on input or `page.evaluate()`.** `timeout` isn't merely defaulted off — it doesn't exist in the wire schema for `mouse.*` / `keyboard.*` / `evaluate`, so no timer is ever armed and a renderer that is alive but wedged parks the caller forever. Always go through the bounded wrappers in [input.ts](../src/browser/input.ts) / `withDeadline` ([deadline.ts](../src/utils/deadline.ts)); never call `page.mouse.*` or `page.keyboard.*` directly.
