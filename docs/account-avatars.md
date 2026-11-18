# Account avatars

The round picture beside an account's name (the account button at the sidebar's foot, the phone's More sheet, each row of Users). v128, Nov 2026.

## What an account shows

One server-side resolver decides, `resolveAccountAvatar` in [avatar-repo.ts](../src/data/repositories/avatar-repo.ts), and every route that hands an account to the UI attaches its answer as `avatar: { kind, url, initial }` (`/api/auth/me`, `/api/auth/login`, `/api/auth/users`, the photo routes). In order:

1. **`photo`**: the photo the account uploaded itself.
2. **`hero`**: the hero portrait of the game player the account *is* in the clan being viewed (`game_players.hero_avatar` → the extracted game art). Which player that is comes from the account's invite link, `linkedGamePlayerId(userId, clanId)` in [account-invite-repo.ts](../src/data/repositories/account-invite-repo.ts) (`user_game_links`, v127 — [account-invites.md](account-invites.md)). Accounts made with a code from the game chat therefore show their hero until they upload a photo. Old password accounts and superadmins have no link.
3. **`initial`**: the first letter of the account name.

The client only paints what it is given ([lib/avatar.js](../src/web/public/lib/avatar.js)). The picture is decorative (`alt=""`): the name always sits beside it.

## Uploading (account menu → Change photo)

[lib/avatar-editor.js](../src/web/public/lib/avatar-editor.js):

- **Any photo works, whatever its size.** There is no limit on the picked file, and the UI never mentions one. It is decoded to a working copy of at most 2048 px on its long edge: `createImageBitmap` with `resizeWidth`/`resizeHeight` and EXIF orientation applied, or an `<img>` drawn onto a canvas where those options aren't supported. A 50-megapixel phone photo never sits in memory at full size. "Preparing photo…" shows while it decodes. On iPhone, `accept="image/*"` hands over HEIC as JPEG.
- **Framing:** the photo sits under a round mask. Drag or touch moves it; pinch, the wheel, the slider or the − / + buttons zoom; the arrow keys and + / − do the same from the keyboard. The visible square is clamped inside the photo, so the circle can never show empty space. The tightest zoom still shows at least 96 source pixels. Previews show the result at the sizes it is used (34 and 28 px).
- **Only the framed square is uploaded:** exported in the browser to 512×512 WebP, or JPEG where the browser can't encode WebP. Re-encoding drops the photo's metadata (EXIF, GPS). The original never leaves the device, and the dialog says so in one line.
- "Remove photo" goes back to the hero or the initial.

## The server

- `PUT /api/auth/avatar` (own account; the raw image as the body) and `DELETE /api/auth/avatar`. Rate-limited to 30 changes per 15 min.
- **Checks happen on the bytes, never the name or the claimed Content-Type** ([image-sniff.ts](../src/utils/image-sniff.ts)). Only PNG, JPEG and WebP are accepted, the size is read from the header, and the image must be square, 64–1024 px. A 2 MB body limit applies to this route only (`express.raw`; the global JSON parser never reads an image body). The browser's 512 px export is a fraction of that, so no one meets it in practice.
- **Stored in the database** (`user_avatars`, one row per account), not on disk, so backups and restores carry the photos. Replacing a photo replaces the row; removing it deletes it. `deleteUser` removes it too ([fk-delete-guards.test.ts](../tests/data/fk-delete-guards.test.ts)).
- **Served publicly at `/avatars/<sha256>.<png|jpg|webp>`** ([routes/avatars.ts](../src/web/routes/avatars.ts)). Static files never sit behind auth ([cloudflare-caching.md](cloudflare-caching.md)), and the content hash makes every new photo a new URL, so the response is `public, max-age=31536000, immutable`. It also carries `X-Content-Type-Options: nosniff` and a `sandbox` CSP, so nothing in it can run. Every other `/avatars/…` path is a plain 404, never the auth redirect. `avatars` is a reserved share key.
- **Taking a photo down:** `DELETE /api/auth/users/:id/avatar`, the "Remove photo" link under a name on Users. The superadmin can remove anyone's. A clan admin can remove those of the accounts its Users page lists: the clan's own members and its guests, never a superadmin. It is audit-logged as `remove_user_avatar`. A removed photo stops being served at once; a copy Cloudflare's edge already holds lives until it expires, at an unguessable URL that nothing references any more.
