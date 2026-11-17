// The game's own art, extracted on the server from the game's public asset
// bundles (src/game-art) and served at /game-art/<version>/<name>.png.
//
// GET /api/game-art is public and small (names + mappings); it is fetched once
// per page load. Until it answers — or on an install whose art has not been
// extracted yet — every helper falls back to what the page used before.

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
 * Picture for a troop of the Tools pages (Citadel, Stacks): the game's own icon
 * for that troop when the art has it, else the bundled picture.
 */
export function troopIconUrl(troopId, fallback) {
  const name = art?.mappings?.mercenaries?.[troopId];
  return (name && gameArtUrl(name)) || fallback;
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
