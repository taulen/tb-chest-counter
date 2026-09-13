"use strict";
/**
 * Shared bounded-int / bounded-float parsing for HTTP query/body inputs.
 *
 * Five copies of "parse a string to an int, fall back if NaN, clamp to
 * [min, max]" had drifted across route files (parseBoundedInt,
 * toBoundedInt, parseInt01, parseFloat01, plus inline copies). Phase A
 * of the refactoring plan consolidates them here so that next time the
 * shape needs to change, one file changes.
 *
 * Behaviour matches the prior `parseBoundedInt(value, fallback, opts)`
 * in src/web/routes/api.ts: nullish or unparseable input yields the
 * fallback; valid input is clamped to the optional `[min, max]` bounds
 * (defaulting to the safe-integer extremes when unset).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBoundedInt = parseBoundedInt;
exports.parseBoundedFloat = parseBoundedFloat;
function parseBoundedInt(value, fallback, options = {}) {
    const min = options.min ?? Number.MIN_SAFE_INTEGER;
    const max = options.max ?? Number.MAX_SAFE_INTEGER;
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
function parseBoundedFloat(value, fallback, options = {}) {
    const min = options.min ?? -Number.MAX_VALUE;
    const max = options.max ?? Number.MAX_VALUE;
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
//# sourceMappingURL=parse-int.js.map