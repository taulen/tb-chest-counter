## What and why

<!-- What broke, or what you wanted it to do. A reproduction beats a description.
     Link the issue or discussion if there is one: "Fixes #123". -->

## How it was tested

<!-- The commands you ran, plus anything checked by hand. Scanning, calibration
     and the login bridge can only be exercised against the real game — say so
     if that's what you did, and what you saw. -->

## Screenshots

<!-- For UI changes. Light and dark theme if the change touches colours. -->

## Checklist

- [ ] `npm run build` passes, and the rebuilt `dist/` is committed with the source — Docker runs `dist/`, not `src/`
- [ ] `npm run test:run` passes
- [ ] The PR does one thing
- [ ] Comments explain *why*, and any comment this change made stale is updated

<!-- Only if they apply — delete the ones that don't: -->

- [ ] Schema change: a new migration after the current highest version, and a regenerated `tests/fixtures/schema-baseline.json` (`node scripts/update-schema-baseline.mjs`)
- [ ] New configuration keyed by a name, path or list has a guard test in `tests/config/`
- [ ] New UI uses the theme's CSS variables rather than hard-coded colours, so Light / Dark / OLED all work
- [ ] New asset references are plain paths (`/lib/thing.js`), never `?v=` — the server path-versions them

<!-- See CONTRIBUTING.md for the reasoning behind each of these. -->
