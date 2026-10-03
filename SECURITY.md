# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/taulen/tb-chest-counter/security/advisories/new)
on this repository. Please don't open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. A proof of concept
helps but isn't required.

This is a hobby project maintained in spare time — expect a reply in days, not
hours.

## What this software is, security-wise

Be clear-eyed about what you are running:

- **It holds a live game session.** The scanner signs in to Total Battle as you
  and keeps the session in `data/clans/<id>/storage-state.json`. Anyone with
  that file, or with admin access to the dashboard, can drive your game account
  through the built-in login bridge. Treat the data volume as a credential
  store.
- **It stores other people's data.** Clan member names, their chest history and
  their resource contributions. They did not install this; you did.
- **It is built for a trusted network.** The dashboard is a single-tenant admin
  tool with password login and role separation, not a multi-tenant SaaS. It is
  not hardened against a hostile authenticated user, and the login bridge in
  particular is a remote-controlled browser that any admin can point anywhere.

## Deploying it safely

- **Don't expose it directly to the internet.** Put it behind a reverse proxy
  with TLS, or keep it on a LAN/VPN. Over plain HTTP the session cookie is sent
  in the clear (the app deliberately does not mark it `Secure` on a plaintext
  request, because a `Secure` cookie over HTTP is silently discarded and login
  simply stops working — see `sessionCookieOptions`).
- **Give superadmin to as few people as possible.** Superadmins can restore
  database backups, restart the container, and open the login bridge.
- **The public share link is genuinely public.** `/<token>` needs no login by
  design. Anyone with the URL sees that clan's leaderboard — and its FAQ, which
  names the clan's admins and the site's superadmins **by username** (accounts
  that have signed in at least once) so visitors know who to ask for access.
  Treat usernames as public and rely on the password: login is rate-limited and
  passwords are hashed with scrypt.
- **Back up the volume, and guard the backups.** A `.db` backup contains
  password hashes, Discord bot tokens and every member's history.

## Known gaps

Listed because knowing is better than discovering. Last reviewed October 2026.

- **The Content-Security-Policy still allows inline script.** CSP is on —
  scripts, styles, images and connections are limited to the app's own origin,
  framing is refused (`frame-ancestors 'none'`), and `<base>` and form targets
  are locked down. But `script-src` keeps `'unsafe-inline'`: every page carries
  one small inline script that applies the theme before first paint. So the
  policy stops scripts loading from elsewhere, not an injected inline one.
- **Rate limiting is per IP and deliberately loose.** Login allows 20 attempts
  per 15 minutes; the rest of the API allows 600 requests a minute as a
  runaway backstop, not a quota. Behind a reverse proxy the limit keys on the
  forwarded client address, so the proxy must set `X-Forwarded-For`.
- **Some error messages are not sanitised.** Unhandled errors return only a
  reference code (details go to the server log), but around two dozen handlers
  on signed-in routes still return the underlying message, which can disclose
  paths or SQL detail to an authenticated user. The public share routes don't.
- **Three paths accept large bodies, before checking who is asking.** Requests
  are capped at 1MB, except the two database-restore routes and resource
  screenshot upload, which allow 110MB. Their handlers require a signed-in
  admin (or the first-run setup), but the body is read before that check runs,
  so an anonymous client can still make the server buffer up to 110MB on those
  paths.

## Third-party terms

Automating a game client may conflict with Total Battle's terms of service, and
the risk of that falls on the account you point it at. This project is not
affiliated with, endorsed by, or connected to Total Battle or Scorewarrior.
