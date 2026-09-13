"use strict";
/**
 * Limits shared by the two sweeps of the in-game members list: the roster build
 * (member-capture.ts) and the might/hero-level read (might-capture.ts).
 *
 * They live here because the pair has already drifted once, expensively. The
 * might sweep raised its ceiling to 250 after measuring that a fixed 50 — the
 * value it had inherited from member capture — truncates a real roster, and
 * wrote down exactly why. Member capture kept the 50, and on a 100-member clan
 * stored 88: it ran out of pages, and being out of pages looks identical to
 * having reached the end of the list.
 *
 * One definition, used by both, is the only version of this that stays true.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMBER_LIST_DRY_PAGES_TO_STOP = exports.MEMBER_LIST_MAX_PAGES = void 0;
/**
 * Hard backstop on scroll pages for one sweep. NOT the real stop condition —
 * that is the dry-page count below — just a runaway guard.
 *
 * A fixed cap is the wrong primary limit: one scroll step advances the list by
 * ~2 rows while the crop shows 3–4, so an 87-member clan needs ~44 pages and a
 * 100-member clan ~46. At 50 there is no margin at all, and a single page that
 * advances by one row instead of two silently shortens the roster. Set high
 * enough that reaching it means something is wrong rather than that the clan is
 * large — which is why both sweeps warn when they do.
 */
exports.MEMBER_LIST_MAX_PAGES = 250;
/**
 * Stop after this many consecutive pages that yield nothing new.
 *
 * "No new names" is the honest end-of-list signal. A crop-hash comparison alone
 * is not: it detects only that the pixels stopped changing, which a wheel event
 * landing on the wrong element also produces, and it cannot tell the bottom of
 * the list from a scroll that didn't take. Requiring several dry pages costs a
 * few seconds at the end and makes an early exit much harder.
 */
exports.MEMBER_LIST_DRY_PAGES_TO_STOP = 4;
//# sourceMappingURL=member-list-sweep.js.map