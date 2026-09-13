// Canonical browser viewport size used by the scanner. Set in
// launcher.ts when the Playwright context is created, and re-used
// as a fallback by image utilities when `sharp` metadata happens to
// be missing dimensions. Centralising it means the launcher viewport
// and the fallbacks can't drift apart silently.
export const DEFAULT_VIEWPORT_WIDTH = 1920;
export const DEFAULT_VIEWPORT_HEIGHT = 1080;
export const DEFAULT_VIEWPORT = {
  width: DEFAULT_VIEWPORT_WIDTH,
  height: DEFAULT_VIEWPORT_HEIGHT,
} as const;
