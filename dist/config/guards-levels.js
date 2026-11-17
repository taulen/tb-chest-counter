"use strict";
/**
 * Guards (Guardsmen) levels: the range, and when a level read from the game
 * counts as old.
 *
 * The level is the Guardsmen tier from the member's own research, as the game
 * reports it (data/repositories/guards-repo.ts). Until Nov 2026 it was
 * estimated from Omen Essence and Scientific Tractates donations; that ladder
 * is retired — docs/guards-and-gold-pass.md has the history.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GUARDS_STALE_DAYS = exports.GUARDS_MAX_LEVEL = exports.GUARDS_MIN_LEVEL = void 0;
exports.GUARDS_MIN_LEVEL = 1;
exports.GUARDS_MAX_LEVEL = 9;
/**
 * Game days since the member's research was last read before the level is
 * shown as old. Every member's city is read once a game day, so a week without
 * a read means the game stopped returning it (they left, or the reads fail) —
 * the level may have moved on since.
 */
exports.GUARDS_STALE_DAYS = 7;
//# sourceMappingURL=guards-levels.js.map