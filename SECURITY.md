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
  design. Anyone with the URL sees that clan's leaderboard.
- **Back up the volume, and guard the backups.** A `.db` backup contains
  password hashes, Discord bot tokens and every member's history.

## Known gaps

Listed because knowing is better than discovering:

- **Content-Security-Policy is off.** `helmet` is configured with
  `contentSecurityPolicy: false`; the frontend uses inline handlers that a
  default policy would break.
- **Rate limiting is narrow.** Login is limited; most other endpoints are not.
- **Error messages are not sanitised.** Some API errors return underlying
  messages, which can disclose paths or SQL detail to an authenticated user.
- **Uploads are large by default.** The JSON body limit is 100MB globally to
  accommodate database restore, rather than being scoped to that one route.

## Third-party terms

Automating a game client may conflict with Total Battle's terms of service, and
the risk of that falls on the account you point it at. This project is not
affiliated with, endorsed by, or connected to Total Battle or Scorewarrior.
