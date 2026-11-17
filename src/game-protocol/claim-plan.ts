/**
 * How a scan opens Gifts-tab chests (message 15013, `{giftId: n}` — n is how
 * many of that entry's chests to open).
 *
 * One request per chest TYPE, the way the game's own "Claim chests" asks for
 * the whole tab, and each entry asked for with its chest count: a summon's
 * drop of 293 chests is one entry, `{id: 293}`. Until Nov 17 2026 stacked
 * entries went one chest per request, like the Open button on a bundle — SIK's
 * 473 chests (one entry of 293, 26 of 4–8) took 462 requests and ~100 s.
 *
 * Requests are capped in entries and in chests; an entry bigger than the chest
 * cap is split across requests (`{id: 100}`, `{id: 100}`, `{id: 93}`). Pure.
 */
export interface ClaimPart<G> {
  gift: G;
  /** Chests of this entry asked for in this request. */
  n: number;
}

export interface ClaimRequest<G> {
  giftType: number;
  parts: Array<ClaimPart<G>>;
  /** Chests the request opens: the parts' n summed. */
  chests: number;
}

export function planGiftClaims<G extends { giftId: number; giftType: number; count: number }>(
  gifts: readonly G[],
  maxEntries: number,
  maxChests: number,
): Array<ClaimRequest<G>> {
  const byType = new Map<number, G[]>();
  for (const g of gifts) {
    if (!(g.count > 0)) continue;
    const list = byType.get(g.giftType) ?? [];
    list.push(g);
    byType.set(g.giftType, list);
  }
  const out: Array<ClaimRequest<G>> = [];
  for (const [giftType, list] of byType) {
    let cur: ClaimRequest<G> | null = null;
    for (const gift of list) {
      let left = gift.count;
      while (left > 0) {
        if (!cur || cur.parts.length >= maxEntries || cur.chests >= maxChests) {
          cur = { giftType, parts: [], chests: 0 };
          out.push(cur);
        }
        const n = Math.min(left, maxChests - cur.chests);
        cur.parts.push({ gift, n });
        cur.chests += n;
        left -= n;
      }
    }
  }
  return out;
}
