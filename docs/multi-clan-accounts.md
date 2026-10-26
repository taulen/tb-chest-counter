# Multi-clan accounts

An account has one **home** clan (`users.clan_id` + `users.role`) and may be granted **extra** clans in `user_clan_access` (v88), each with its own role, `admin` or `user`. It switches between them with the header clan switcher (`POST /api/clans/:clanId/activate`), the same one superadmins use. Superadmins never hold rows; they are cross-clan already.

## The security model is one choke point

- **`validateSession` ([user-repo.ts](../src/data/repositories/user-repo.ts)) returns the user SCOPED TO THE ACTIVE CLAN**: `clanId` is the clan being viewed and `role` is the role held there. Every existing gate compares `req.user.clanId` / `req.user.role`, so each one already confines the account to that one clan with that clan's rights. Two things follow: an admin at home who is a plain user next door has no admin rights next door, and no `:clanId` route reaches a clan the account isn't currently viewing (not even its home).
- **The grant is re-read on every request.** The session's `active_clan_id` is only a pointer, and a pointer with no live grant behind it is ignored. Revoking a grant, or soft-deleting the clan, drops the account home on its very next call. The activate route checks too, but that is a convenience, not the gate.
- **So `req.user.clanId` is never "the home clan".** Use `getUserById` for that, and `listSwitchableClans` for what the account may switch to.

## Who may change what

| Action | Who |
|---|---|
| Grant extra clans, move the home clan (`PUT /api/auth/users/:id/clans`, `PUT /api/auth/users/:id/clan`) | superadmin only |
| Change a guest's role in a clan, or remove them from it (`PUT`/`DELETE /api/auth/users/:id/clans/:clanId`) | superadmin, or an admin **currently in that clan**; only an existing grant, never creates one |
| Delete the account, or change its account-level role | as before: the home clan's admins (and superadmins) |

All of it is pinned by the `multi-clan accounts` block in [role-gates.test.ts](../tests/web/security/role-gates.test.ts).

## Not leaking across clans

- **User listings** (`getAllUsers`): a clan admin sees their guests as members of their own clan with the role held there, and is never told the guest's home clan or other clans. Only the superadmin listing carries `clanAccess`.
- **Share keys** in `GET /api/clans` are included only for clans where the account is admin.
- **Audit log:** `logAction` stamps the request's clan ([request-context.ts](../src/utils/request-context.ts), set by `requireAuth`). Clan views filter on that, so work done in clan B never appears in clan A's log. Rows from before the stamp existed (NULL) fall back to the actor's home clan.
- **Site contacts** (`listSiteContacts`) count anyone who is admin *in that clan*: home admins plus guest admins.

## Housekeeping

Promoting to superadmin clears every grant. Moving the home clan drops a grant for the new home. `deleteUser` and `deleteClan` remove their rows; [fk-delete-guards.test.ts](../tests/data/fk-delete-guards.test.ts) holds both to it. A soft-deleted clan keeps its grants (they are inert) and they come back if the clan is restored.
