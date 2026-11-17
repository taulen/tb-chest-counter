/**
 * Total Battle game art, extracted from the game's own Unity asset bundles in
 * pure Node and served per game version. Public API; see store.ts for the
 * pipeline and selection.ts for what is extracted.
 */
export {
  ensureGameArt,
  startGameArtSchedule,
  stopGameArtSchedule,
  currentGameArt,
  gameArtUrl,
  heroAvatarImage,
  avatarFrameImage,
  gameArtDir,
  type GameArtIndex,
  type GameArtImage,
  type EnsureGameArtResult,
} from './store.js';
export { createGameArtRouter } from './routes.js';
export { ART_CATEGORIES, ART_PATTERNS, type ArtCategory } from './selection.js';
export { matchTroopIcons, heroAvatarImageFrom, avatarFrameImageFrom, type ArtMappings, type TroopStats } from './mappings.js';
