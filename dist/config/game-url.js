"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TB_GAME_URL = void 0;
/**
 * The Total Battle game URL is the same for every clan and every
 * deployment — clan switching happens inside the game's canvas, not
 * via different domains. We hardcode it here rather than expose a
 * GAME_URL env var or a per-clan field so there's exactly one value
 * to maintain.
 *
 * If TB ever changes the canonical URL, edit this constant.
 */
exports.TB_GAME_URL = 'https://totalbattle.com';
//# sourceMappingURL=game-url.js.map