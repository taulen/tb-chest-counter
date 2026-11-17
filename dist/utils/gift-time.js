"use strict";
/**
 * Every Total Battle gift starts life with a fixed 20-hour claim window; the
 * game discards it some time after that. A scan gap longer than this loses
 * gifts for good, which is what the scan-coverage check measures against.
 *
 * Earn times themselves come straight from the game (the protocol scan stores
 * each gift's arrival time as earned_at). Rows recorded by the retired
 * screenshot reader derived theirs from the card's "time left" countdown,
 * falling back to the scan clock (earned_at == captured_at) when it could not
 * be read.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GIFT_LIFETIME_MS = void 0;
/** Fixed starting lifetime of every gift's claim window. */
exports.GIFT_LIFETIME_MS = 20 * 60 * 60 * 1000;
//# sourceMappingURL=gift-time.js.map