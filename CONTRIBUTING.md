# Contributing

Thanks for looking. This is a self-hosted hobby project; contributions are
welcome, and so are bug reports that just describe what happened.

## Getting set up

```bash
npm install          # installs Playwright's Chromium too
npm run typecheck    # tsc --noEmit, app + tests
npm run test:run     # vitest, ~1000 tests, no DB or network needed
npm run dev          # tsx watch on src/index.ts
```

You do not need a Total Battle account to work on most of this. The tests are
pure — they run against fixtures and an in-memory SQLite database. What you
cannot test offline is anything that drives the browser (scanning, calibration,
the login bridge); those are exercised by running the real thing.

## Two conventions that will bite you

**1. `dist/` is committed, and Docker runs it.** There is no build step in the
`Dockerfile` — it copies `dist/`. So a change that isn't compiled and committed
has not shipped, no matter how correct the TypeScript is.

```bash
npm run build        # guards + tsc, then commit dist/ alongside src/
```

Use `npm run build`, not a bare `npx tsc`: `build` runs the config guard tests
first (see below).

**2. Asset URLs are path-versioned, never query-versioned.** Reference
`/lib/thing.js` in HTML and let the rewriter turn it into
`/v/<build>/lib/thing.js`. A `?v=` query string is not part of the base URL an
ES module's relative imports resolve against, so it versions the entry point
and none of its imports — and some CDNs key on path alone regardless. This has
caused a real multi-hour outage; `tests/config/public-share-assets.test.ts`
pins it.

## The guard tests

`tests/config/` holds pure tests that `npm run build` runs before compiling.
They exist because this codebase has a recurring failure shape: **configuration
that silently resolves to nothing**, which looks exactly like a real result of
zero. Each guard pins one such surface — catalog chest names against the name
corrector, the asset allowlists against the real import graphs, the calibration
checklist against the gate that blocks scanning.

If you add configuration that is keyed by a name, a path or a list, add the
guard with it.

## Style

There is no linter. Match the file you are in.

The one thing worth knowing: **comments here explain why, not what.** Several
decisions in this codebase look wrong until you know the measurement behind
them (why the resource cursor ignores the newest day, why OCR has no timeout,
why a flat page cap was the wrong limit). If you change one of those, change
its comment; if you find one that has gone stale, fixing it is a welcome PR on
its own.

## Pull requests

- Say what broke, or what you wanted it to do. A reproduction beats a
  description.
- Run `npm run build` and `npm run test:run`, and commit the resulting `dist/`.
- Keep a PR to one thing. Small and boring merges quickly.

## Reporting bugs

Include the scanner's logs if it is a scanning problem — the System page has a
log buffer, and `docker logs <container>` has the rest. A screenshot of what the
game looked like at the time is worth a lot; most failures here are the game
showing something unexpected rather than the code being wrong about something
it saw.
