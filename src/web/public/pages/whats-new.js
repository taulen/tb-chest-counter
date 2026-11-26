// Tools → What's new: what each game patch added, read from the game's own
// files the moment it patched (src/game-patch/notes.ts) — new research trees
// drawn as the game draws them, captains, events, chests, cosmetics, the
// game's own help for a coming feature, every new text, and a gallery of the
// new art. Much of it isn't live in the game yet: a patch ships content first.
//
// SECTION_VIEWS gives each kind of game data a label and a layout; a kind the
// server lists that isn't there still shows (humanised key, rows) — so new
// data appears without a change here, and a line here only makes it read
// better. The server side of that registry is src/game-patch/notes-sections.ts.

import { api } from '../lib/api.js';
import { contentModal, esc, formatRelativeTime, openCropLightbox } from '../lib/ui.js';
import { emptyHtml, errorStateHtml, foldHtml, refusalText, statTileHtml, statTilesHtml, wireRetry } from '../lib/ui-kit.js';
import { getLanguage, t, tn, tGame } from '../lib/i18n.js';
import { treeHtml } from './member-techs.js';
import { loadTreeStatus, notLiveNoteHtml, notLiveTagHtml, wireTreeLevels } from '../lib/tech-levels.js';
import { markGamePatchSeen } from '../lib/state.js';

const PHONE = '(max-width: 640px)';
/** Entries shown before "Show all". */
const SHOWN = 24;

/** "new_temple" → "New temple". */
function humanize(key) {
  const s = String(key || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** A name that is still the game's text key ("tech.name.melee_strength_6"): the game hasn't written it yet. */
const KEY_LIKE = /^[a-z0-9_]+(\.[a-z0-9_%]+)+$/i;

/** A name for an entry: the game's (translated), else its untranslated key or picture made readable. */
function entryName(e) {
  if (e.name && !e.unnamed) return tGame(e.name);
  if (e.name) return humanize(e.name.split('.').pop());
  return humanize(e.id);
}

const KIND_BADGE = {
  added: () => `✦ ${t('New')}`,
  revealed: () => `◉ ${t('Revealed')}`,
  renamed: () => `✎ ${t('Renamed')}`,
  changed: () => `↻ ${t('Changed')}`,
  removed: () => `✕ ${t('Removed')}`,
};
const badgeHtml = (kind) => `<span class="wn-badge is-${esc(kind)}">${esc(KIND_BADGE[kind]?.() ?? kind)}</span>`;

/** The game's own text, readable: markup dropped, line breaks kept, placeholders marked. */
function gameTextHtml(s) {
  if (!s) return '';
  const plain = String(s).replace(/\\n/g, '\n').replace(/<[^>]*>/g, '');
  return esc(plain)
    .replace(/%([A-Za-z0-9_.:]+)%/g, (_, name) => `<span class="wn-ph">${esc(humanize(name.toLowerCase()))}</span>`)
    .replace(/\n/g, '<br>');
}

/** One word of the game's text, escaped, a placeholder marked. */
function wordHtml(w) {
  return esc(w).replace(/%([A-Za-z0-9_.:]+)%/g, (_, name) => `<span class="wn-ph">${esc(humanize(name.toLowerCase()))}</span>`);
}

/**
 * A reworded text as one line: words it lost struck, words it gained marked
 * (an LCS over words, punctuation and case aside). Very long texts fall back
 * to before / after.
 */
function wordDiffHtml(was, now) {
  const words = (s) => String(s || '').replace(/\\n/g, ' ').replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean);
  const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, '');
  const a = words(was);
  const b = words(now);
  if (a.length * b.length > 60_000) {
    return `<span class="wn-text-was">${gameTextHtml(was)}</span><span class="wn-text-now">${gameTextHtml(now)}</span>`;
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = key(a[i]) === key(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]) === key(b[j])) {
      out.push(wordHtml(b[j]));
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`<ins>${wordHtml(b[j])}</ins>`);
      j++;
    } else {
      out.push(`<del>${wordHtml(a[i])}</del>`);
      i++;
    }
  }
  return `<span class="wn-text-diff">${out.join(' ')}</span>`;
}

/** A text in the reader's language, English when the game has none in it. */
const inLang = (x) => (x ? x[getLanguage()] ?? x.en ?? '' : '');

// ─── Drill-downs ─────────────────────────────────────────────

function pairsHtml(lines) {
  if (!Array.isArray(lines) || !lines.length) return '';
  return `<ul class="captain-bonus-list">${lines.map((l) => `<li><span>${esc(tGame(l?.[0] ?? ''))}</span><span class="captain-bonus-value">${esc(String(l?.[1] ?? ''))}</span></li>`).join('')}</ul>`;
}

function changesHtml(e) {
  if (!e.changes?.length) return '';
  const rows = e.changes.map((c) => {
    const label = [c.at, c.text ? tGame(c.text) : ''].filter(Boolean).join(' · ');
    const was = c.was === null ? `<span class="wn-none">${esc(t('none'))}</span>` : esc(c.was);
    const now = c.now === null ? `<span class="wn-none">${esc(t('gone'))}</span>` : esc(c.now);
    return `<li class="wn-change"><span class="wn-change-label">${esc(label)}</span><span class="wn-change-values"><s>${was}</s> → <b>${now}</b></span></li>`;
  }).join('');
  const more = e.moreChanges ? `<p class="ui-sub">${esc(tn(e.moreChanges, 'and {n} more change', 'and {n} more changes', { n: e.moreChanges }))}</p>` : '';
  return `<div class="captain-detail-section">${esc(t('What changed'))}</div><ul class="wn-changes">${rows}</ul>${more}`;
}

function wasLine(e) {
  if (!e.was) return '';
  const was = KEY_LIKE.test(e.was) ? humanize(e.was.split('.').pop()) : tGame(e.was);
  return `<p class="ui-sub">${esc(e.kind === 'revealed' ? t('Before: a placeholder ({name})', { name: was }) : t('Was: {name}', { name: was }))}</p>`;
}

function pictureHtml(e, cls = 'wn-pic') {
  const url = e.artUrl || e.iconUrl;
  if (e.backUrl && e.frameUrl && e.iconUrl) {
    return `<span class="${cls} wn-layered" aria-hidden="true">
        <img class="wn-layer-back" src="${esc(e.backUrl)}" alt="" decoding="async">
        <img class="wn-layer-face" src="${esc(e.iconUrl)}" alt="" loading="lazy" decoding="async">
        <img class="wn-layer-frame" src="${esc(e.frameUrl)}" alt="" decoding="async">
      </span>`;
  }
  return url
    ? `<span class="${cls}" aria-hidden="true"><img src="${esc(url)}" alt="" loading="lazy" decoding="async"></span>`
    : `<span class="${cls} is-empty" aria-hidden="true">${esc(entryName(e).slice(0, 1))}</span>`;
}

/** The drill-down body every kind shares: picture, name line, the kind's facts, what changed. */
function detailHtml(e, facts = '') {
  const big = e.artUrl
    ? `<div class="wn-detail-art"><img src="${esc(e.artUrl)}" alt="" decoding="async"></div>`
    : `<div class="wn-detail-art is-icon">${pictureHtml(e, 'wn-detail-pic')}</div>`;
  return `<div class="wn-detail ${rarityClass(e)}">
      ${big}
      <div class="wn-detail-body">
        <div class="wn-detail-head">${badgeHtml(e.kind)}${e.sub ? `<span class="wn-detail-sub">${esc(tGame(e.sub))}</span>` : ''}</div>
        ${wasLine(e)}
        ${e.ids?.length > 1 ? `<p class="ui-sub">${esc(tn(e.ids.length, '{n} variant in the game data', '{n} variants in the game data', { n: e.ids.length }))}</p>` : ''}
        ${facts}
        ${changesHtml(e)}
      </div>
    </div>`;
}

function rarityClass(e) {
  const r = Number(e.detail?.rarity);
  if (e.detail?.rarityName && r) return `wn-r-${r}`;
  const q = Number(e.detail?.quality ?? e.detail?.grade);
  return q ? `wn-q-${q}` : '';
}

const fact = (label, value) => (value === undefined || value === null || value === '' ? '' : `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`);

function captainFacts(e) {
  const stars = e.detail?.stars && typeof e.detail.stars === 'object' ? Object.entries(e.detail.stars) : [];
  if (!stars.length) return '';
  return stars.map(([s, lines]) => `<div class="captain-detail-section">${esc(t('Star level {n}', { n: s }))}</div>${pairsHtml(lines)}`).join('');
}

function artifactFacts(e) {
  const d = e.detail || {};
  return `<dl class="captain-detail-facts">
      ${fact(t('Max level'), d.maxLevel)}
      ${fact(t('Max star level'), d.maxStar)}
    </dl>
    ${d.first ? `<div class="captain-detail-section">${esc(t('Level {n}', { n: d.firstLevel ?? 1 }))}</div>${pairsHtml(d.first)}` : ''}
    ${d.last ? `<div class="captain-detail-section">${esc(t('Level {n}', { n: d.lastLevel ?? d.maxLevel }))}</div>${pairsHtml(d.last)}` : ''}
    ${d.bonuses?.length ? `<div class="captain-detail-section">${esc(t('Random bonuses'))}</div>${pairsHtml(d.bonuses)}` : ''}`;
}

function titleFacts(e) {
  const d = e.detail || {};
  const days = d.seconds ? Math.round(d.seconds / 86400) : 0;
  return `${d.description ? `<p class="ui-copy">${gameTextHtml(tGame(d.description))}</p>` : ''}
    <dl class="captain-detail-facts">
      ${fact(t('Source'), d.source ? esc(tGame(d.source)) : '')}
      ${fact(t('Lasts'), days ? esc(tn(days, '{n} day', '{n} days', { n: days })) : '')}
    </dl>`;
}

function medalFacts(e) {
  const d = e.detail || {};
  return d.description ? `<p class="ui-copy">${gameTextHtml(tGame(d.description))}</p>` : '';
}

function giftFacts(e) {
  const d = e.detail || {};
  return `<dl class="captain-detail-facts">${fact(t('Source'), d.source ? esc(tGame(d.source)) : '')}${fact(t('Quality'), d.quality ? esc(String(d.quality)) : '')}</dl>`;
}

function equipmentFacts(e) {
  return pairsHtml(e.detail?.lines);
}

function unitFacts(e) {
  const d = e.detail || {};
  const n = (v) => (v === undefined ? '' : esc(Number(v).toLocaleString('en-US')));
  return `<dl class="captain-detail-facts">${fact(t('Tier'), d.tier ? esc(`T${d.tier}`) : '')}${fact(t('Strength'), n(d.strength))}${fact(t('Health'), n(d.health))}</dl>`;
}

/**
 * Each kind of game data: its label, its layout (portraits · tiles · rows) and
 * the facts its drill-down shows. A kind missing here still shows: humanised
 * key, rows, the changes.
 */
const SECTION_VIEWS = {
  events: { label: () => t('Events'), layout: 'rows' },
  captains: { label: () => t('Captains'), layout: 'portraits', facts: captainFacts },
  heroes: { label: () => t('Hero portraits'), layout: 'portraits' },
  artifacts: { label: () => t('Artifacts'), layout: 'tiles', facts: artifactFacts },
  gifts: { label: () => t('Chests and items'), layout: 'tiles', facts: giftFacts },
  titles: { label: () => t('Titles'), layout: 'tiles', facts: titleFacts },
  medals: { label: () => t('Clan medals'), layout: 'tiles', facts: medalFacts },
  equipment: { label: () => t('Equipment'), layout: 'tiles', facts: equipmentFacts },
  inserts: { label: () => t('Gems and enchantments'), layout: 'tiles' },
  factions: { label: () => t('Factions'), layout: 'tiles' },
  techs: { label: () => t('Research'), layout: 'rows' },
  objects: { label: () => t('Map objects'), layout: 'rows' },
  terrains: { label: () => t('Terrain'), layout: 'rows' },
  frames: { label: () => t('Avatar frames'), layout: 'tiles' },
  cityLooks: { label: () => t('City looks'), layout: 'tiles' },
  units: { label: () => t('Troops and monsters'), layout: 'portraits', facts: unitFacts },
};
const viewOf = (key) => SECTION_VIEWS[key] ?? { label: () => humanize(key), layout: 'rows' };

const TEXT_GROUP_LABELS = {
  '': () => t('Other texts'),
  help: () => t('Help windows'),
  tech: () => t('Research'),
  item: () => t('Items'),
  customization: () => t('Cosmetics'),
  titles: () => t('Titles'),
};

// ─── Rendering ─────────────────────────────────────────────

let patches = [];
let selected = null;
/** Drill-downs of the patch on screen, by index (data-wn-open). */
let openers = [];

function opener(fn) {
  openers.push(fn);
  return openers.length - 1;
}

function entryModal(section, e) {
  const view = viewOf(section.key);
  return () => contentModal({ title: entryName(e), html: detailHtml(e, view.facts ? view.facts(e) : ''), className: 'wn-modal' });
}

function hasDrill(section, e) {
  return !!(e.changes?.length || e.was || e.artUrl || e.iconUrl || viewOf(section.key).facts);
}

function tileEntryHtml(section, e, i, layout) {
  const drill = hasDrill(section, e);
  const tag = drill ? 'button' : 'div';
  const attrs = drill ? ` type="button" data-wn-open="${opener(entryModal(section, e))}" aria-haspopup="dialog"` : '';
  const sub = e.kind === 'renamed' && e.was ? t('was {name}', { name: tGame(e.was) }) : e.sub ? tGame(e.sub) : '';
  const extra = i >= SHOWN ? ' is-extra' : '';
  const count = e.ids?.length > 1 ? `<span class="wn-count">×${e.ids.length}</span>` : '';
  if (layout === 'rows') {
    return `<li class="ui-row wn-row${extra}">
        ${e.iconUrl ? pictureHtml(e, 'wn-row-pic') : ''}
        <${tag} class="wn-row-main"${attrs}>
          <span class="ui-row-name">${esc(entryName(e))}${count}</span>
          ${sub ? `<span class="ui-row-sub">${esc(sub)}</span>` : ''}
        </${tag}>
        ${badgeHtml(e.kind)}
      </li>`;
  }
  return `<li class="wn-cell${extra}">
      <${tag} class="wn-card ${layout === 'portraits' ? 'is-portrait' : ''} ${rarityClass(e)}"${attrs}>
        ${pictureHtml(e)}
        <span class="wn-card-name">${esc(entryName(e))}${count}</span>
        ${sub ? `<span class="wn-card-sub">${esc(sub)}</span>` : ''}
        ${badgeHtml(e.kind)}
      </${tag}>
    </li>`;
}

function sectionHtml(section) {
  const view = viewOf(section.key);
  const layout = view.layout;
  const items = section.entries.map((e, i) => tileEntryHtml(section, e, i, layout)).join('');
  const more = section.entries.length > SHOWN
    ? `<button type="button" class="btn btn-tight wn-more" data-wn-more>${esc(t('Show all {n}', { n: section.entries.length }))}</button>`
    : '';
  const list = layout === 'rows' ? `<ul class="ui-rows wn-rows">${items}</ul>` : `<ul class="wn-cards is-${layout}">${items}</ul>`;
  return `<section class="ui-tile span-12 wn-section" id="wn-${esc(section.key)}">
      <div class="ui-tile-head"><h2 class="ui-tile-title">${esc(view.label())}</h2><span class="ui-sub">${esc(String(section.entries.length))}</span></div>
      ${list}
      ${more}
    </section>`;
}

/** A tree's research the game doesn't draw yet: tiles, the new ones marked. */
function unplacedHtml(note) {
  const list = note.tree.unplaced || [];
  if (!list.length) return '';
  const fresh = new Set(note.newNodes || []);
  const shown = note.kind === 'added' ? list : list.filter((n) => fresh.has(n.techId));
  if (!shown.length) return '';
  const tiles = shown.map((n) => {
    const name = KEY_LIKE.test(n.name) ? humanize(n.name.split('.').pop()) : tGame(n.name);
    return `<li class="wn-unplaced-node${fresh.has(n.techId) && note.kind !== 'added' ? ' is-new' : ''}" data-tech-id="${n.techId}" role="button" tabindex="0" title="${esc([name, n.description || ''].filter(Boolean).join('\n'))}">
      ${n.iconUrl ? `<img src="${esc(n.iconUrl)}" alt="" loading="lazy" decoding="async">` : '<span class="wn-unplaced-blank" aria-hidden="true"></span>'}
      <span class="wn-unplaced-text"><span class="wn-unplaced-name">${esc(name)}</span><span class="wn-unplaced-max">${esc(t('max {max}', { max: n.maxLevel }))}</span></span>
    </li>`;
  }).join('');
  return `<div class="captain-detail-section">${esc(tn(shown.length, '{n} research not in the tree yet', '{n} research not in the tree yet', { n: shown.length }))}</div>
    <p class="ui-sub">${esc(t('In the game data, but the game does not draw these in the tree yet.'))}</p>
    <ul class="wn-unplaced">${tiles}</ul>`;
}

function treeOpener(note, allTrees) {
  return () => {
    const phone = window.matchMedia(PHONE).matches;
    const newIds = new Set(note.newNodes || []);
    const raised = note.raised?.length
      ? `<p class="ui-sub">${esc(tn(note.raised.length, '{n} research got more levels', '{n} research got more levels', { n: note.raised.length }))}</p>`
      : '';
    const html = `<div class="wn-tree">
        ${note.tree.description ? `<p class="ui-copy">${esc(tGame(note.tree.description))}</p>` : ''}
        ${raised}
        ${notLiveNoteHtml(note.tree)}
        <p class="ui-sub">${esc(t('Tap a research for its levels: cost, time and bonus.'))}</p>
        <div class="wn-tree-view">
          ${note.tree.nodes.length ? treeHtml(note.tree, {}, { trees: allTrees }, phone, { preview: true, newIds: note.kind === 'added' ? null : newIds }) : ''}
          ${unplacedHtml(note)}
        </div>
      </div>`;
    const modal = contentModal({ title: tGame(note.tree.name), html, wide: true, className: 'wn-tree-modal' });
    const view = modal?.content.querySelector('.wn-tree-view');
    if (view) wireTreeLevels(view, () => note.tree, {});
  };
}

function treesHtml(notes) {
  const trees = notes.trees.filter((n) => n.kind !== 'removed');
  if (!trees.length) return '';
  const all = notes.trees.map((n) => n.tree);
  const cards = trees.map((n) => {
    const research = [...n.tree.nodes, ...(n.tree.unplaced || [])];
    const levels = research.reduce((sum, x) => sum + (x.maxLevel || 0), 0);
    const facts = n.kind === 'added'
      ? t('{nodes} research · {levels} levels', { nodes: research.length, levels: levels.toLocaleString('en-US') })
      : tn(n.newNodes.length, '{n} new research', '{n} new research', { n: n.newNodes.length });
    return `<li><button type="button" class="wn-tree-card" data-wn-open="${opener(treeOpener(n, all))}" aria-haspopup="dialog">
        ${n.tree.iconUrl ? `<img class="wn-tree-icon" src="${esc(n.tree.iconUrl)}" alt="" decoding="async">` : '<span class="wn-tree-icon is-empty" aria-hidden="true"></span>'}
        <span class="wn-tree-text">
          <span class="wn-tree-name">${esc(tGame(n.tree.name))}</span>
          ${n.tree.tab ? `<span class="wn-tree-tab">${esc(tGame(n.tree.tab))}</span>` : ''}
          <span class="wn-tree-facts">${esc(facts)}</span>
          ${notLiveTagHtml(n.tree.id)}
          ${n.tree.description ? `<span class="wn-tree-desc">${esc(tGame(n.tree.description))}</span>` : ''}
        </span>
        ${badgeHtml(n.kind === 'added' ? 'added' : 'changed')}
        <span class="wn-tree-cta">${esc(t('See the tree'))} →</span>
      </button></li>`;
  }).join('');
  return `<section class="ui-tile span-12 wn-section" id="wn-trees">
      <div class="ui-tile-head"><h2 class="ui-tile-title">${esc(t('Research trees'))}</h2><span class="ui-sub">${esc(String(trees.length))}</span></div>
      <ul class="wn-trees">${cards}</ul>
    </section>`;
}

/** The headline row: the patch's biggest finds as big cards. */
function spotlightHtml(notes) {
  const cards = [];
  for (const n of notes.trees) {
    if (n.kind !== 'added') continue;
    cards.push(`<button type="button" class="wn-spot is-tree" data-wn-open="${opener(treeOpener(n, notes.trees.map((x) => x.tree)))}" aria-haspopup="dialog">
        ${n.tree.iconUrl ? `<img class="wn-spot-pic" src="${esc(n.tree.iconUrl)}" alt="" decoding="async">` : '<span class="wn-spot-pic is-empty" aria-hidden="true"></span>'}
        <span class="wn-spot-kind">${esc(t('Research tree'))}</span>
        <span class="wn-spot-name">${esc(tGame(n.tree.name))}</span>
      </button>`);
  }
  const pick = (key, kinds) => notes.sections.find((s) => s.key === key)?.entries.filter((e) => kinds.includes(e.kind) && e.name && !e.unnamed) ?? [];
  const kindLabel = { captains: t('Captain'), artifacts: t('Artifact'), events: t('Event'), frames: t('Avatar frame'), cityLooks: t('City look'), units: t('Troop') };
  for (const key of ['captains', 'events', 'artifacts', 'cityLooks', 'frames', 'units']) {
    const section = notes.sections.find((s) => s.key === key);
    // An event the game only re-titled (one run of a series) isn't a find; a new one is.
    for (const e of pick(key, key === 'events' ? ['added'] : ['added', 'revealed'])) {
      if (cards.length >= 12) break;
      cards.push(`<button type="button" class="wn-spot ${rarityClass(e)}" data-wn-open="${opener(entryModal(section, e))}" aria-haspopup="dialog">
          ${e.iconUrl || e.artUrl ? pictureHtml(e, 'wn-spot-pic') : `<span class="wn-spot-pic is-glyph" aria-hidden="true">${key === 'events' ? '⚑' : '✦'}</span>`}
          <span class="wn-spot-kind">${esc(kindLabel[key])}</span>
          <span class="wn-spot-name">${esc(entryName(e))}</span>
        </button>`);
    }
  }
  if (!cards.length) return '';
  return `<section class="ui-tile span-12 wn-section wn-spotlight-tile">
      <div class="ui-tile-head"><h2 class="ui-tile-title">${esc(t('Biggest finds'))}</h2></div>
      <div class="wn-spotlight">${cards.join('')}</div>
    </section>`;
}

function guidesHtml(notes) {
  if (!notes.guides.length) return '';
  const folds = notes.guides.map((g, i) => {
    const firstTitle = g.parts.find((p) => p.title)?.title;
    const title = inLang(g.title) || inLang(firstTitle) || humanize(g.key);
    const body = g.parts.map((p) => `<div class="wn-guide-part">
        ${p.title && inLang(p.title) !== title ? `<h3 class="wn-guide-title">${gameTextHtml(inLang(p.title))}</h3>` : ''}
        ${p.texts.map((x) => `<p class="ui-copy">${gameTextHtml(inLang(x))}</p>`).join('')}
      </div>`).join('');
    return foldHtml({ key: `wn-guide-${g.key}`, title: esc(title), body, open: i === 0, inset: true, cls: 'wn-guide' });
  }).join('');
  return `<section class="ui-tile span-12 wn-section" id="wn-guides">
      <div class="ui-tile-head"><h2 class="ui-tile-title">${esc(t("The game's own guides"))}</h2><span class="ui-sub">${esc(t('New help in the game, word for word'))}</span></div>
      <div class="wn-folds">${folds}</div>
    </section>`;
}

function textsHtml(notes) {
  if (!notes.texts.length) {
    return notes.textsUnavailable
      ? `<section class="ui-tile span-12 wn-section" id="wn-texts"><div class="ui-tile-head"><h2 class="ui-tile-title">${esc(t('Game texts'))}</h2></div>${emptyHtml(t("This patch's texts couldn't be compared: the game no longer serves the previous ones."))}</section>`
      : '';
  }
  const labelOf = (g) => TEXT_GROUP_LABELS[g.key]?.() ?? (inLang(g.title) || humanize(g.key));
  const changedHtml = (x) => `<li class="wn-text is-changed">${wordDiffHtml(inLang(x.was), inLang(x.text))}</li>`;
  // A feature with new or removed texts is a fold of its own; one that was only
  // reworded joins the "Reworded" fold at the end — polish, not news.
  const features = notes.texts.filter((g) => g.added.length || g.removed.length);
  const polished = notes.texts.filter((g) => !g.added.length && !g.removed.length && g.changed.length);
  const folds = features.map((g) => {
    const counts = [
      g.added.length ? tn(g.added.length, '{n} new', '{n} new', { n: g.added.length }) : '',
      g.changed.length ? tn(g.changed.length, '{n} reworded', '{n} reworded', { n: g.changed.length }) : '',
      g.removed.length ? tn(g.removed.length, '{n} removed', '{n} removed', { n: g.removed.length }) : '',
    ].filter(Boolean).join(' · ');
    const added = g.added.map((x) => `<li class="wn-text">${gameTextHtml(inLang(x.text))}</li>`).join('');
    const changed = g.changed.map(changedHtml).join('');
    const removed = g.removed.map((x) => `<li class="wn-text is-removed">${gameTextHtml(inLang(x.text))}</li>`).join('');
    const body = `${added ? `<ul class="wn-texts">${added}</ul>` : ''}
      ${changed ? `<div class="captain-detail-section">${esc(t('Reworded'))}</div><ul class="wn-texts">${changed}</ul>` : ''}
      ${removed ? `<div class="captain-detail-section">${esc(t('Removed'))}</div><ul class="wn-texts">${removed}</ul>` : ''}`;
    return foldHtml({
      key: `wn-texts-${g.key || 'other'}`,
      title: `${esc(labelOf(g))} <span class="wn-fold-count">${esc(counts)}</span>`,
      body,
      inset: true,
    });
  });
  if (polished.length) {
    const n = polished.reduce((sum, g) => sum + g.changed.length, 0);
    const body = polished.map((g) => `<div class="captain-detail-section">${esc(labelOf(g))}</div><ul class="wn-texts">${g.changed.map(changedHtml).join('')}</ul>`).join('');
    folds.push(foldHtml({
      key: 'wn-texts-reworded',
      title: `${esc(t('Reworded'))} <span class="wn-fold-count">${esc(tn(n, '{n} reworded', '{n} reworded', { n }))}</span>`,
      body,
      inset: true,
    }));
  }
  const cut = notes.textsTruncated ? `<p class="ui-sub">${esc(tn(notes.textsTruncated, '{n} more text not shown', '{n} more texts not shown', { n: notes.textsTruncated }))}</p>` : '';
  return `<section class="ui-tile span-12 wn-section" id="wn-texts">
      <div class="ui-tile-head"><h2 class="ui-tile-title">${esc(t('Game texts'))}</h2><span class="ui-sub">${esc(t('Grouped by feature, the most new first'))}</span></div>
      <div class="wn-folds">${folds.join('')}</div>
      ${cut}
    </section>`;
}

/** A new picture and what the game's data and texts say about it. */
function artAboutHtml(g) {
  const pics = g.pictures.map((p) => `<span class="wn-art-big"><img src="${esc(p.url)}" alt="" decoding="async"></span>`).join('');
  const names = (g.about?.names || []).map((n) => `<li>${esc(tGame(n))}</li>`).join('');
  const texts = (g.about?.texts || []).map((x) => `<p class="ui-copy">${gameTextHtml(inLang(x))}</p>`).join('');
  return `<div class="wn-detail">
      <div class="wn-detail-art is-gallery">${pics}</div>
      <div class="wn-detail-body">
        ${names ? `<div class="captain-detail-section">${esc(t('In the game data as'))}</div><ul class="wn-about-names">${names}</ul>` : ''}
        ${texts ? `<div class="captain-detail-section">${esc(t('The game says'))}</div>${texts}` : ''}
      </div>
    </div>`;
}

function imagesHtml(notes) {
  if (!notes.images.length) return '';
  // What the game describes first, then the rest, then shop and widget art (offer panels, banners).
  const PROMO = /^(?:special_offer|action_widget|static_widget|banner|promo)_/;
  const rank = (g) => (g.about ? 0 : PROMO.test(g.stem) ? 2 : 1);
  const pictured = notes.images.filter((g) => g.pictures.length).sort((a, b) => rank(a) - rank(b));
  const bare = notes.images.filter((g) => !g.pictures.length);
  const cells = pictured.map((g) => {
    const p = g.pictures[0];
    const named = g.about?.names?.[0] ? tGame(g.about.names[0]) : '';
    const said = g.about?.texts?.length ? g.about.texts : [];
    const caption = named || (said[0] ? inLang(said[0]).replace(/\\n/g, ' ').replace(/<[^>]*>/g, '') : '') || humanize(g.stem);
    // A picture the game says something about opens onto that; the rest open big.
    const open = named || said.length
      ? `data-wn-open="${opener(() => contentModal({ title: caption, html: artAboutHtml(g), className: 'wn-modal' }))}" aria-haspopup="dialog"`
      : `data-wn-image="${esc(p.url)}"`;
    return `<li><button type="button" class="wn-art${named || said.length ? ' is-about' : ''}" ${open} title="${esc(g.names.join(', '))}">
        <span class="wn-art-pic"><img src="${esc(p.url)}" alt="" loading="lazy" decoding="async"></span>
        <span class="wn-art-name">${esc(caption)}</span>
      </button></li>`;
  }).join('');
  const names = bare.length
    ? foldHtml({
      key: 'wn-art-names',
      title: esc(tn(bare.length, '{n} more without a picture yet', '{n} more without a picture yet', { n: bare.length })),
      body: `<ul class="wn-art-names">${bare.map((g) => `<li title="${esc(g.names.join(', '))}">${esc(humanize(g.stem))}</li>`).join('')}</ul>`,
      inset: true,
    })
    : '';
  return `<section class="ui-tile span-12 wn-section" id="wn-images">
      <div class="ui-tile-head"><h2 class="ui-tile-title">${esc(t('New art'))}</h2><span class="ui-sub">${esc(t('Pictures the game added that nothing above shows'))}</span></div>
      ${cells ? `<ul class="wn-gallery">${cells}</ul>` : ''}
      ${names}
    </section>`;
}

/** The headline numbers; each jumps to its part. */
function countsHtml(summary) {
  const c = summary?.counts || {};
  const tiles = [];
  const add = (key, label, target) => {
    if (c[key]) tiles.push(statTileHtml({ label, value: esc(Number(c[key]).toLocaleString('en-US')), attrs: `data-wn-jump="${esc(target)}" role="link" tabindex="0"` }));
  };
  add('trees', t('Research trees'), 'wn-trees');
  add('events', t('Events'), 'wn-events');
  add('captains', t('Captains'), 'wn-captains');
  add('artifacts', t('Artifacts'), 'wn-artifacts');
  add('gifts', t('Chests and items'), 'wn-gifts');
  add('guides', t('Guides'), 'wn-guides');
  add('texts', t('New texts'), 'wn-texts');
  add('images', t('New art'), 'wn-images');
  return statTilesHtml(tiles, 'wn-stats');
}

function switcherHtml() {
  const i = patches.findIndex((p) => p.id === selected);
  const p = patches[i];
  const older = patches[i + 1];
  const newer = patches[i - 1];
  const day = p ? p.date.slice(0, 10) : '';
  return `<div class="wn-switcher">
      <button type="button" class="btn btn-tight" data-wn-patch="${esc(older?.id ?? '')}"${older ? '' : ' disabled'} aria-label="${esc(t('Older patch'))}">‹</button>
      <div class="wn-switcher-label">
        <span class="wn-switcher-title">${esc(t('Game patch of {date}', { date: day }))}</span>
        <span class="ui-sub">${esc(t('Read {when}', { when: formatRelativeTime(p?.date) }))}${patches.length > 1 ? ` · ${esc(t('{i} of {n}', { i: i + 1, n: patches.length }))}` : ''}</span>
      </div>
      <button type="button" class="btn btn-tight" data-wn-patch="${esc(newer?.id ?? '')}"${newer ? '' : ' disabled'} aria-label="${esc(t('Newer patch'))}">›</button>
    </div>`;
}

async function renderPatch(mount) {
  openers = [];
  const body = mount.querySelector('.wn-body');
  body.innerHTML = `<p class="muted-copy">${esc(t('Loading…'))}</p>`;
  let notes;
  try {
    notes = await api(`/game-updates/${encodeURIComponent(selected)}?lang=${encodeURIComponent(getLanguage())}`);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    notes = null;
  }
  if (!notes || !Array.isArray(notes.sections)) {
    body.innerHTML = errorStateHtml(t("Couldn't load this patch."), refusalText(notes));
    wireRetry(body, () => renderPatch(mount));
    return;
  }
  const summary = patches.find((p) => p.id === selected);
  body.innerHTML = `${countsHtml(summary)}
    <div class="ui-grid wn-grid">
      ${spotlightHtml(notes)}
      ${treesHtml(notes)}
      ${notes.sections.map(sectionHtml).join('')}
      ${guidesHtml(notes)}
      ${textsHtml(notes)}
      ${imagesHtml(notes)}
    </div>`;
}

function wire(mount) {
  mount.addEventListener('click', (ev) => {
    const open = ev.target.closest('[data-wn-open]');
    if (open) {
      openers[Number(open.dataset.wnOpen)]?.();
      return;
    }
    const img = ev.target.closest('[data-wn-image]');
    if (img) {
      openCropLightbox(img.dataset.wnImage, { returnFocusTo: img });
      return;
    }
    const more = ev.target.closest('[data-wn-more]');
    if (more) {
      more.closest('.wn-section')?.classList.add('is-all');
      more.remove();
      return;
    }
    const jump = ev.target.closest('[data-wn-jump]');
    if (jump) {
      document.getElementById(jump.dataset.wnJump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const nav = ev.target.closest('[data-wn-patch]');
    if (nav && nav.dataset.wnPatch) {
      selected = nav.dataset.wnPatch;
      mount.querySelector('.wn-switch').innerHTML = switcherHtml();
      void renderPatch(mount);
    }
  });
  mount.addEventListener('keydown', (ev) => {
    const jump = ev.target.closest?.('[data-wn-jump]');
    if (jump && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      document.getElementById(jump.dataset.wnJump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

export async function renderWhatsNew(mount) {
  mount.innerHTML = `<p class="muted-copy">${esc(t('Loading…'))}</p>`;
  let list;
  try {
    [list] = await Promise.all([api('/game-updates'), loadTreeStatus()]);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    list = null;
  }
  if (!list || !Array.isArray(list.patches)) {
    mount.innerHTML = errorStateHtml(t("Couldn't load what's new."), refusalText(list));
    wireRetry(mount, () => renderWhatsNew(mount));
    return;
  }
  patches = list.patches;
  if (!patches.length) {
    mount.innerHTML = `<div class="ui-tile span-12">${emptyHtml(t('No game patch has been compared yet. The next one shows here as soon as the game publishes it.'))}</div>`;
    return;
  }
  // Seen here: Home's note for this patch stays away until the next one.
  markGamePatchSeen(patches[0].id);
  if (!patches.some((p) => p.id === selected)) selected = patches[0].id;
  mount.innerHTML = `<div class="wn">
      <p class="ui-copy wn-intro">${esc(t("Read from the game's own files the moment it patched. Much of it isn't in the game yet: a patch ships new content before it goes live."))}</p>
      <div class="wn-switch">${switcherHtml()}</div>
      <div class="wn-body"></div>
    </div>`;
  wire(mount);
  await renderPatch(mount);
}
