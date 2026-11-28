// The game's own art, extracted on the server from the game's public asset
// bundles (src/game-art) and served at /game-art/<version>/<name>.png.
//
// GET /api/game-art is public and small (names + mappings); it is fetched once
// per page load. Until it answers — or on an install whose art has not been
// extracted yet — the helpers give no image (troops get a neutral tile): only
// the game's own art is ever shown, nothing bundled in the repo.

let art = null;
/** art.names as a Set: an index holds thousands of names and a page asks for hundreds. */
let artNames = new Set();
/** Whether the index maps any chest to a picture (chestLabelHtml). */
let chestArt = false;
let loading = null;

/** Start (or reuse) the one fetch of the art index. Resolves to the index or null. */
export function loadGameArt() {
  if (!loading) {
    loading = fetch('/api/game-art', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        art = j && j.base ? j : null;
        artNames = new Set(art?.names ?? []);
        chestArt = Object.keys(art?.mappings?.chests ?? {}).length > 0;
        return art;
      })
      .catch(() => { loading = null; return null; });
  }
  return loading;
}

/** URL of a game image by name, or null when there is none (yet). */
export function gameArtUrl(name) {
  return art && name && artNames.has(name) ? `${art.base}${name}.png` : null;
}

/**
 * The game's own icon for a troop of the Tools pages (Citadel, Stacks), or null.
 * `troops` covers every troop and defender; an index extracted before Nov 2026
 * has only `mercenaries`.
 */
export function troopIconUrl(troopId) {
  const name = art?.mappings?.troops?.[troopId] ?? art?.mappings?.mercenaries?.[troopId];
  return name ? gameArtUrl(name) : null;
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The game's frame for a troop's icon — back, frame and tier badge, chosen by
 * the unit's tier (src/game-art/unit-frames.ts) — or null when the art has
 * none (not extracted yet, an index from before frames, or no tier matched).
 */
function troopFrame(troopId) {
  return frameForTier(art?.mappings?.troopTiers?.[troopId]);
}

/** The back, frame and tier badge the game draws a unit of this tier (T9 f2) on, or null. */
function frameForTier(tier) {
  if (tier === null || tier === undefined) return null;
  const f = art?.mappings?.unitFrames?.[String(tier)];
  const back = gameArtUrl(f?.back);
  const frame = gameArtUrl(f?.frame);
  if (!back || !frame) return null;
  return { back, frame, badge: gameArtUrl(f.badge), numeral: f.numeral ?? null };
}

/** An icon on its frame (or plain, or a lettered tile): the markup troopIconHtml and unitIconHtml share. */
function framedIconHtml(url, frame, name, size, cls) {
  if (url && frame) {
    const num = frame.numeral ? `<span class="unit-icon-num">${attr(frame.numeral)}</span>` : '';
    const badge = frame.badge ? `<span class="unit-icon-tier"><img src="${attr(frame.badge)}" alt="" decoding="async">${num}</span>` : '';
    return `<span class="unit-icon${cls ? ` ${attr(cls)}` : ''}" style="--unit-size:${size}px;width:${size}px;height:${size}px" aria-hidden="true">`
      + `<img class="unit-icon-back" src="${attr(frame.back)}" alt="" decoding="async">`
      + `<img class="unit-icon-art" src="${attr(url)}" alt="" decoding="async">`
      + `<img class="unit-icon-frame" src="${attr(frame.frame)}" alt="" decoding="async">`
      + `${badge}</span>`;
  }
  if (url) {
    return `<img${cls ? ` class="${attr(cls)}"` : ''} src="${attr(url)}" alt="" width="${size}" height="${size}" decoding="async">`;
  }
  const letter = (String(name ?? '').trim()[0] ?? '?').toUpperCase();
  return `<span class="troop-icon-ph${cls ? ` ${attr(cls)}` : ''}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px" aria-hidden="true">${attr(letter)}</span>`;
}

/**
 * Any game unit's picture from battle-data.json (its T9 icon name and tier):
 * every unit icon is extracted, so the monsters of the map have theirs too.
 * Same markup as troopIconHtml.
 */
export function unitIconHtml(unit, name, { size = 36, cls = '' } = {}) {
  const url = unit?.icon ? gameArtUrl(String(unit.icon).toLowerCase()) : null;
  return framedIconHtml(url, url ? frameForTier(unit.tier) : null, name, size, cls);
}

/**
 * A troop's picture: the game's own icon on the game's own back and frame,
 * coloured by its tier with the tier badge in the corner, as the game draws
 * it; the plain icon when there is no frame; or — when the art has no icon
 * (not extracted yet, or no unit matched) — a neutral tile with the name's
 * first letter. `size` is the whole picture, frame and badge included. Only
 * the game's art is ever shown; decorative, the name is beside it.
 */
export function troopIconHtml(troopId, name, { size = 36, cls = '' } = {}) {
  const url = troopIconUrl(troopId);
  return framedIconHtml(url, url ? troopFrame(troopId) : null, name, size, cls);
}

/** The game's picture for an Ancient planner key (tome, figurine, clock, tinman), or null. */
export function ancientArtUrl(key) {
  return gameArtUrl(art?.mappings?.ancients?.[key]);
}

/** The game's icon for a chest by its name, or null. */
export function chestIconUrl(chestName) {
  return gameArtUrl(art?.mappings?.chests?.[chestName]);
}

// ─── Item tiles, reward chips, chest tiles ──────────────────────────────────
// An item drawn the way the game's inventory and reward windows draw it (the
// item-tile sprites from the WebGL client, src/game-art/unit-frames.ts
// ITEM_QUALITY_COLOURS): the icon on a back coloured by its quality grade
// (T8 f10 1–8, Poor grey … Godlike gold; the plain brown back without a
// grade), inside the thin bronze item frame. Geometry and the amount badge:
// style.css "Game item tiles". Item icons are by item id and come from the
// server with the data (item-icons.ts); chest icons can also go by name.

/** The tile's back and frame for a quality grade; null pieces when the art lacks them. */
function itemFrameUrls(quality) {
  const f = art?.mappings?.itemFrames;
  if (!f) return { back: null, frame: null };
  const graded = Number(quality) > 0 ? f.backs?.[String(quality)] : null;
  return { back: gameArtUrl(graded ?? f.plainBack), frame: gameArtUrl(f.frame) };
}

/**
 * A game item's picture: its icon on the back of its quality grade in the
 * item frame, as the game draws it; the bare icon when `framed` is false or
 * the frame art is missing; a neutral tile with the name's first letter when
 * there is no icon (art not extracted yet, or an item the art lacks) — never
 * a broken image, never a picture of ours. Decorative: the name or amount
 * belongs beside it (or in a label around it).
 *
 * @param {string|null} iconUrl  the item's icon URL (from the server, by item id)
 * @param {object} [opts]
 * @param {number} [opts.size=40]     the whole tile in px, frame included
 * @param {number} [opts.quality=0]   T8 quality grade 1–8; 0 = none (plain back)
 * @param {string} [opts.name='']     display name, for the placeholder's letter
 * @param {boolean} [opts.framed=true] draw the back and frame
 * @param {string} [opts.badge='']    short text over the bottom-right, the way
 *                                    the game prints an amount on a reward ("250K", "×3")
 * @param {string} [opts.cls='']      extra class(es)
 */
export function itemIconHtml(iconUrl, { size = 40, quality = 0, name = '', framed = true, badge = '', cls = '' } = {}) {
  const q = Number(quality) > 0 ? Number(quality) : 0;
  const classes = ['game-item', q ? `game-item-q${q}` : '', cls].filter(Boolean).join(' ');
  // The size is a custom property, so a layout can resize tiles in CSS (a
  // phone grid); style.css sizes the box from it.
  const style = `--gi-size:${size}px`;
  const badgeHtml = badge ? `<span class="game-item-badge">${esc(badge)}</span>` : '';
  if (!iconUrl) {
    const letter = (String(name ?? '').trim()[0] ?? '?').toUpperCase();
    return `<span class="${attr(classes)} is-empty" style="${style}" aria-hidden="true"><span class="game-item-letter">${esc(letter)}</span>${badgeHtml}</span>`;
  }
  const { back, frame } = framed ? itemFrameUrls(q) : { back: null, frame: null };
  if (!frame) {
    return `<span class="${attr(classes)} is-bare" style="${style}" aria-hidden="true">`
      + `<img class="game-item-art" src="${attr(iconUrl)}" alt="" decoding="async" loading="lazy">${badgeHtml}</span>`;
  }
  return `<span class="${attr(classes)}" style="${style}" aria-hidden="true">`
    + (back ? `<img class="game-item-back" src="${attr(back)}" alt="" decoding="async" loading="lazy">` : '')
    + `<img class="game-item-art" src="${attr(iconUrl)}" alt="" decoding="async" loading="lazy">`
    + `<img class="game-item-frame" src="${attr(frame)}" alt="" decoding="async" loading="lazy">`
    + `${badgeHtml}</span>`;
}

/**
 * A chest's picture as an item tile (itemIconHtml): the chest's own icon —
 * `url` when the caller has it (by gift type, exact), else the chest NAME's
 * icon (chestIconUrl) — framed in its quality grade when one is known.
 * Missing art gives the neutral placeholder. `chestName` is the English name
 * the art maps; pass `name` for a translated placeholder letter.
 *
 * @param {string} chestName
 * @param {{ size?: number, url?: string|null, quality?: number, framed?: boolean, name?: string, badge?: string, cls?: string }} [opts]
 */
export function chestIconHtml(chestName, { size = 40, url = null, quality = 0, framed = true, name = '', badge = '', cls = '' } = {}) {
  return itemIconHtml(url || chestIconUrl(chestName), {
    size, quality, framed, badge, name: name || chestName, cls: ['game-chest', cls].filter(Boolean).join(' '),
  });
}

/** Whether the art index has loaded with chest pictures (chestLabelHtml draws them). */
export function hasChestArt() {
  return chestArt;
}

/**
 * A chest's name with the game's picture of it in front: how every page lists
 * a chest (tables, breakdowns, the points guide). The bare icon, no tile — at
 * table sizes a frame is noise, and only the Chest rewards tab knows a chest's
 * quality grade — then `labelHtml`, the name exactly as the caller rendered it
 * before (escaped text, a link, or a name-over-source stack), so links,
 * ellipsis and wrapping stay the page's own. Geometry: style.css .chest-label.
 *
 * Decorative: the name stays the text. Until the art index has answered, or on
 * an install without chest art, it is the label alone — the plain name, as
 * before; a chest the art lacks gets the neutral letter tile, so a column of
 * names still lines up. Pages await loadGameArt() before their first render.
 *
 * @param {string} chestName  the English chest name the art maps
 * @param {string} labelHtml  the name as HTML, already escaped
 * @param {{ size?: number, name?: string, cls?: string }} [opts]
 *   size: px (22 in a table row, 28 beside a two-line name, 16 in a phone
 *   row's summary line); name: the translated name, for the placeholder letter
 */
export function chestLabelHtml(chestName, labelHtml, { size = 22, name = '', cls = '' } = {}) {
  if (!chestArt) return labelHtml;
  const icon = chestIconHtml(chestName, { size, framed: false, name });
  return `<span class="chest-label${cls ? ` ${attr(cls)}` : ''}">${icon}<span class="chest-label-text">${labelHtml}</span></span>`;
}

/**
 * A reward the way the game's reward window lists one: the item tile with
 * the amount printed over its corner and the name under it — or, `inline`,
 * a small tile with the amount beside it (dense table cells, where a badge
 * would not fit). The whole chip is one labelled image for assistive tech
 * ("Silver: 1,250,000").
 *
 * @param {{ name: string, iconUrl?: string|null, quality?: number }} item  name already for display (tGame)
 * @param {string} amount  short amount ("1.3M", "2d 4h", "12"); '' for none
 * @param {object} [opts]
 * @param {number} [opts.size=56]
 * @param {'stack'|'inline'} [opts.layout='stack']
 * @param {string} [opts.label]   full text for the tooltip and screen readers (default "name: amount")
 * @param {boolean} [opts.showName=true]  the name under the tile (stack only)
 * @param {string} [opts.sub='']  an extra muted line under the name (stack only)
 * @param {string} [opts.cls='']
 */
export function rewardChipHtml(item, amount, { size = 56, layout = 'stack', label, showName = true, sub = '', cls = '' } = {}) {
  const name = String(item?.name ?? '');
  const full = label ?? (amount ? `${name}: ${amount}` : name);
  const inline = layout === 'inline';
  const tile = itemIconHtml(item?.iconUrl ?? null, { size, quality: item?.quality ?? 0, name, badge: inline ? '' : amount });
  const classes = ['reward-chip', inline ? 'is-inline' : '', cls].filter(Boolean).join(' ');
  return `<span class="${attr(classes)}" role="img" aria-label="${attr(full)}" title="${attr(full)}" style="--gi-size:${size}px">`
    + tile
    + (inline && amount ? `<span class="reward-chip-amount">${esc(amount)}</span>` : '')
    + (!inline && showName ? `<span class="reward-chip-name">${esc(name)}</span>` : '')
    + (!inline && sub ? `<span class="reward-chip-sub">${esc(sub)}</span>` : '')
    + '</span>';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The game's icon for a resource by its name, or null. */
export function resourceIconUrl(resourceName) {
  return gameArtUrl(art?.mappings?.resources?.[resourceName]);
}

/**
 * The game's small picture for a city state or holding, or null:
 * shield (Shield of Peace), burning, wallsDown, flame (legible at 16 px),
 * city (the default city), goldIngots. See STATUS_ART in src/game-art/selection.ts.
 */
export function statusIconUrl(key) {
  return gameArtUrl(art?.mappings?.status?.[key]);
}

/**
 * A player's city as the game shows it: their city look (game_players.
 * city_appearance; the default "Player's City" when unknown) at the highest
 * level step their city level has reached. Null when the art has none.
 */
export function cityLookUrl(lookId, cityLevel) {
  const looks = art?.mappings?.cityLooks;
  if (!looks) return null;
  const icons = looks[String(lookId)] ?? looks['9'];
  if (!icons) return null;
  const steps = Object.keys(icons).map(Number).sort((a, b) => a - b);
  const level = Number(cityLevel) > 0 ? Number(cityLevel) : 1;
  const step = [...steps].reverse().find((s) => s <= level) ?? steps[0];
  return gameArtUrl(icons[String(step)]);
}

/** The plate the game writes the hero level on over a framed portrait, or null. */
export function heroLevelBadgeUrl() {
  return gameArtUrl(art?.mappings?.heroLevelBadge);
}

// Start at import: by the time a page renders its first table the index is
// usually in, and pages that render earlier re-render on their next update.
loadGameArt();
