import { describe, expect, it } from 'vitest';
import { isSameGift, repeatedLeadingCards, type SeenCard } from '../../src/scheduler/crop-overlap.js';

// A batch screenshots 4 cards then clicks Open 4 times. When a click doesn't
// consume its card, the bottom of one crop reappears at the top of the next —
// 11% of a real 205k-row database was one gift recorded twice. These pin the
// two halves of the rule that drops the repeat: the card is the same, AND its
// earn estimate moved by exactly the screenshot gap (the countdown is
// minute-granular, so a re-read shifts by the gap, or the gap minus one minute
// when the displayed minute ticked between the two shots).

const GAP = 2_500; // observed screenshot-to-screenshot interval
const T0 = Date.parse('2026-09-18T09:00:00.000Z');

/** A card as the OCR phase sees it. `earn` is relative to T0 for readability. */
const card = (identity: string, earn: number | null): SeenCard => ({
  identity,
  earnedAt: earn === null ? null : T0 + earn,
});

const crop = (cards: SeenCard[], cropMs = 0) => ({ cards, cropMs: T0 + cropMs });

describe('repeatedLeadingCards', () => {
  it('finds nothing when the batch consumed every card it showed', () => {
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    const cur = [card('e', GAP), card('f', GAP), card('g', GAP), card('h', GAP)];
    expect(repeatedLeadingCards(prev, cur, T0 + GAP)).toBe(0);
  });

  it('drops the bottom card when it comes back at the top', () => {
    // Same gift, same displayed minute: its earn estimate moves by the gap.
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    const cur = [card('d', GAP), card('e', GAP), card('f', GAP), card('g', GAP)];
    expect(repeatedLeadingCards(prev, cur, T0 + GAP)).toBe(1);
  });

  it('still drops it when the countdown ticked a minute between screenshots', () => {
    // ~4% of re-reads, and the reason the rule takes two exact values rather
    // than one: the displayed minute fell by one, so the estimate moves by
    // gap − 60s. Without this they read as a different gift and survive.
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    const cur = [card('d', GAP - 60_000), card('e', GAP), card('f', GAP), card('g', GAP)];
    expect(repeatedLeadingCards(prev, cur, T0 + GAP)).toBe(1);
  });

  it('drops a run of cards when several clicks in a batch missed', () => {
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    const cur = [card('c', GAP), card('d', GAP), card('e', GAP), card('f', GAP)];
    expect(repeatedLeadingCards(prev, cur, T0 + GAP)).toBe(2);
  });

  it('drops the whole crop when no click landed at all', () => {
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    const cur = [card('a', GAP), card('b', GAP), card('c', GAP), card('d', GAP)];
    expect(repeatedLeadingCards(prev, cur, T0 + GAP)).toBe(4);
  });

  it('requires the run to be anchored at both ends', () => {
    // 'c' repeats, but from the MIDDLE of the previous crop — the list slides
    // as a unit, so that is not what an unconsumed card looks like. Matching it
    // would delete a real chest.
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    const cur = [card('c', GAP), card('x', GAP), card('y', GAP), card('z', GAP)];
    expect(repeatedLeadingCards(prev, cur, T0 + GAP)).toBe(0);
  });

  it('keeps a same-named gift whose earn time says it is a different one', () => {
    // Identity alone is not enough: a member can receive the same chest from
    // the same source twice. Here the second arrived 7 minutes after the first,
    // so the shift is nowhere near the screenshot gap.
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    const cur = [card('d', GAP + 7 * 60_000), card('e', GAP), card('f', GAP), card('g', GAP)];
    expect(repeatedLeadingCards(prev, cur, T0 + GAP)).toBe(0);
  });

  it('keeps a card whose countdown never parsed', () => {
    // No countdown, no evidence. An extra row is recoverable; a chest dropped
    // on a guess is not.
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', null)]);
    const cur = [card('d', null), card('e', GAP), card('f', GAP), card('g', GAP)];
    expect(repeatedLeadingCards(prev, cur, T0 + GAP)).toBe(0);
  });

  it('ignores crops that are not an adjacent pair', () => {
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    // A 40s gap — the sweep stalled between the two, so "the list slid by one"
    // is no longer the story the timestamps tell.
    expect(repeatedLeadingCards(prev, [card('d', 40_000)], T0 + 40_000)).toBe(0);
    // And a non-advancing clock can't be an adjacent pair either.
    expect(repeatedLeadingCards(prev, [card('d', 0)], T0)).toBe(0);
  });

  it('handles a short final crop', () => {
    const prev = crop([card('a', 0), card('b', 0), card('c', 0), card('d', 0)]);
    expect(repeatedLeadingCards(prev, [card('d', GAP)], T0 + GAP)).toBe(1);
    expect(repeatedLeadingCards(crop([]), [card('d', GAP)], T0 + GAP)).toBe(0);
  });
});

describe('isSameGift', () => {
  it('accepts exactly the two shifts a re-read can produce, and nothing else', () => {
    const a = card('x', 0);
    expect(isSameGift(a, card('x', GAP), GAP)).toBe(true); // same displayed minute
    expect(isSameGift(a, card('x', GAP - 60_000), GAP)).toBe(true); // minute ticked
    expect(isSameGift(a, card('x', GAP - 1), GAP)).toBe(false); // ±1ms is not a tolerance
    expect(isSameGift(a, card('x', GAP + 60_000), GAP)).toBe(false); // a minute LATER is a new gift
    expect(isSameGift(a, card('y', GAP), GAP)).toBe(false); // different card
  });
});
