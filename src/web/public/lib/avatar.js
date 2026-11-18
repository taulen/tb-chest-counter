/**
 * The round picture beside an account (account menu, Users page). The server
 * decides what it is (avatar-repo.resolveAccountAvatar): the account's own
 * photo, else its game hero's portrait, else its initial — and sends it as
 * `{ kind, url, initial }` on every account it returns.
 */
import { esc } from './ui.js';

/** The account's first letter, for an account sent without an avatar. */
function initialOf(user) {
  return (Array.from(String(user?.username ?? '').trim())[0] ?? '?').toUpperCase();
}

/**
 * Inner markup for an avatar circle: an <img> for a photo or a hero portrait,
 * else the initial. Decorative — the account's name always sits beside it.
 */
export function avatarInnerHtml(user) {
  const a = user?.avatar;
  if (a?.url) {
    return `<img class="avatar-img" src="${esc(a.url)}" alt="" decoding="async" loading="lazy" draggable="false">`;
  }
  return esc(a?.initial || initialOf(user));
}

/** A whole avatar circle, for lists: `<span class="avatar avatar-<size>">…</span>`. */
export function avatarHtml(user, { size = 'sm' } = {}) {
  const kind = user?.avatar?.url ? (user.avatar.kind === 'hero' ? 'is-hero' : 'is-photo') : 'is-initial';
  return `<span class="avatar avatar-${size} ${kind}" aria-hidden="true">${avatarInnerHtml(user)}</span>`;
}

/** Fill an existing avatar element (the account button's) in place. */
export function paintAvatar(el, user) {
  if (!el) return;
  const kind = user?.avatar?.url ? (user.avatar.kind === 'hero' ? 'is-hero' : 'is-photo') : 'is-initial';
  el.classList.remove('is-hero', 'is-photo', 'is-initial');
  el.classList.add(kind);
  el.innerHTML = avatarInnerHtml(user);
}
