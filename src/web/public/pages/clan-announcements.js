// My Clan → Announcements: clan announcements members shared in the clan's
// chats (or sent the scanner account in a private message), read from the
// game's journal (GET /api/game/clan/announcements, docs/battle-reports.md).
// Newest first; each one is its one-line headline (data/announcement-
// headline.ts: the first real line of the text, greetings skipped), the day
// and its author, with the whole text folded under it — the newest open.
// The strip over My Clan's tabs (clan.js) shows the newest one's headline.

import { api } from '../lib/api.js';
import { esc, formatDate } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import { emptyHtml, errorStateHtml, notesHtml, refusalText, wireRetry } from '../lib/ui-kit.js';

/** The panel's placeholder until the tab is first opened (mountAnnouncements fills it). */
export function announcementsPanelHtml() {
  return `<div class="clan-announcements" data-clan-announcements><div class="ui-tile span-12"><p class="ui-sub">${t('Loading…')}</p></div></div>`;
}

/** "2026/11/27 16:01" in the viewer's clock. */
const when = (iso) => formatDate(iso).slice(0, 16);

/** The strip over My Clan's tabs: the newest announcement's headline, a link to the tab. '' when there is none. */
export function latestAnnouncementHtml(a) {
  if (!a?.headline) return '';
  return `<a class="ui-tile span-12 clan-ann-strip" href="#clan/announcements">
      <span class="clan-ann-label">${esc(t('Announcement'))}</span>
      <span class="clan-ann-headline">${esc(a.headline)}</span>
      <span class="clan-ann-meta">${esc(when(a.at))}${a.author ? ` · ${esc(a.author)}` : ''}</span>
    </a>`;
}

function itemHtml(a, i) {
  return `<details class="ann-item"${i === 0 ? ' open' : ''}>
      <summary>
        <span class="ann-headline">${esc(a.headline)}</span>
        <span class="ann-meta">${esc(when(a.at))}${a.author ? ` · ${esc(a.author)}` : ''}</span>
      </summary>
      <div class="ann-text">${esc(a.text)}</div>
    </details>`;
}

const notes = () => notesHtml([
  esc(t('Shared in the clan chat, or sent to the scanner account in a private message: an announcement shows here within a few minutes.')),
  esc(t('The headline is the announcement’s first line, greetings left out.')),
]);

/** Fill the panel when the tab first shows (the element is fresh every render). */
export async function mountAnnouncements(content) {
  const box = content.querySelector('[data-clan-announcements]');
  if (!box || box.dataset.loaded) return;
  let res;
  try {
    res = await api('/game/clan/announcements');
  } catch (err) {
    if (err?.name === 'AbortError') return;
    res = null;
  }
  const why = refusalText(res);
  if (!res || why || !Array.isArray(res.announcements)) {
    box.innerHTML = `<div class="ui-tile span-12">${errorStateHtml(t("Couldn't load the announcements. Try again in a minute."), why)}</div>`;
    wireRetry(box, () => mountAnnouncements(content));
    return;
  }
  box.dataset.loaded = '1';
  const list = res.announcements;
  box.innerHTML = list.length
    ? `<div class="ui-tile span-12 ann-list">${list.map(itemHtml).join('')}</div>${notes()}`
    : `<div class="ui-tile span-12">${emptyHtml(t('No clan announcement has been shared yet.'))}</div>${notes()}`;
}
