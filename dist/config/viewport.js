"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_VIEWPORT = exports.DEFAULT_VIEWPORT_HEIGHT = exports.DEFAULT_VIEWPORT_WIDTH = void 0;
// Canonical browser viewport size used by the scanner. Set in
// launcher.ts when the Playwright context is created, and re-used
// as a fallback by image utilities when `sharp` metadata happens to
// be missing dimensions. Centralising it means the launcher viewport
// and the fallbacks can't drift apart silently.
exports.DEFAULT_VIEWPORT_WIDTH = 1920;
exports.DEFAULT_VIEWPORT_HEIGHT = 1080;
exports.DEFAULT_VIEWPORT = {
    width: exports.DEFAULT_VIEWPORT_WIDTH,
    height: exports.DEFAULT_VIEWPORT_HEIGHT,
};
//# sourceMappingURL=viewport.js.map