/**
 * Which game player a site account is, per clan.
 *
 * SEAM: accounts are not linked to game players yet. The chat-invite account
 * system (docs/account-invites.md, being built on its own branch) adds the
 * link table — an account redeems a code the clan's scanner sent that player,
 * and from then on the account IS that player in that clan. Its lookup plugs
 * in here, and nothing else changes: the avatar resolver
 * (avatar-repo.resolveAccountAvatar) already asks this for the hero portrait.
 *
 * Until then every account is unlinked, so the avatar falls back from an
 * uploaded photo straight to the initial.
 */
export function linkedGamePlayerId(_userId: number, _clanId: number): number | null {
  return null;
}
