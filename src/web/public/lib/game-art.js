// The game's own art, extracted on the server from the game's public asset
// bundles (src/game-art) and served at /game-art/<version>/<name>.png.
//
// GET /api/game-art is public and small (names + mappings); it is fetched once
// per page load. Until it answers — or on an install whose art has not been
// extracted yet — the helpers give no image (troops get a neutral tile): only
// the game's own art is ever shown, nothing bundled in the repo.

let art = null;
let loading = null;

/** Start (or reuse) the one fetch of the art index. Resolves to the index or null. */
export function loadGameArt() {
  if (!loading) {
    loading = fetch('/api/game-art', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { art = j && j.base ? j : null; return art; })
      .catch(() => { loading = null; return null; });
  }
  return loading;
}

/** URL of a game image by name, or null when there is none (yet). */
export function gameArtUrl(name) {
  return art && name && art.names?.includes(name) ? `${art.base}${name}.png` : null;
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
  const tier = art?.mappings?.troopTiers?.[troopId];
  if (tier === null || tier === undefined) return null;
  const f = art?.mappings?.unitFrames?.[String(tier)];
  const back = gameArtUrl(f?.back);
  const frame = gameArtUrl(f?.frame);
  if (!back || !frame) return null;
  return { back, frame, badge: gameArtUrl(f.badge), numeral: f.numeral ?? null };
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
  const frame = url ? troopFrame(troopId) : null;
  if (frame) {
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

/** The game's picture for an Ancient planner key (tome, figurine, clock, tinman), or null. */
export function ancientArtUrl(key) {
  return gameArtUrl(art?.mappings?.ancients?.[key]);
}

/** The game's icon for a chest by its name, or null. */
export function chestIconUrl(chestName) {
  return gameArtUrl(art?.mappings?.chests?.[chestName]);
}

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
