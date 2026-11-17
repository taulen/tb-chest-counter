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
 * A troop's picture: the game's own icon, or — when the art has none (not
 * extracted yet, or no unit matched) — a neutral tile with the name's first
 * letter. Only the game's art is ever shown; decorative, the name is beside it.
 */
export function troopIconHtml(troopId, name, { size = 36, cls = '' } = {}) {
  const url = troopIconUrl(troopId);
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

// Start at import: by the time a page renders its first table the index is
// usually in, and pages that render earlier re-render on their next update.
loadGameArt();
