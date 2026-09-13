import { describe, expect, it } from 'vitest';
import { parseGiftCards } from '../../src/vision/gift-parser.js';

/**
 * parseGiftCards turns the OCR text of the clan Gifts panel into
 * structured gift entries. A card is identified by its "From:" line and
 * the gift NAME is the real-word text immediately preceding it — NOT by
 * the word "Chest", so non-chest event rewards still count.
 */

describe('parseGiftCards', () => {
  it('parses a standard chest gift', () => {
    const text = [
      'Stone Chest',
      'From: Player1 Time left: 5h 30m',
      'Source: Crypt Open',
    ].join('\n');
    const cards = parseGiftCards(text);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      playerName: 'Player1',
      chestName: 'Stone Chest',
      source: 'Crypt',
      timeLeft: '5h30m',
      giftTab: 'gifts',
    });
  });

  it('parses a non-chest event gift whose name lacks the word "Chest"', () => {
    // This is the regression case: "Prepared alchemical cauldron" was
    // silently dropped by the old /chest/i-gated parser, making the
    // scanner think the gift list was empty and abort navigation.
    const text = [
      'Prepared alchemical cauldron',
      'From: KingArthur Time left: 17h 49m',
      'Source: Alchemy tournament Open',
    ].join('\n');
    const cards = parseGiftCards(text);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      playerName: 'KingArthur',
      chestName: 'Prepared alchemical cauldron',
      source: 'Alchemy tournament',
      timeLeft: '17h49m',
    });
  });

  it('parses several cards in one crop, chest and non-chest mixed', () => {
    const text = [
      'Prepared alchemical cauldron',
      'From: Alice Time left: 17h 49m',
      'Source: Alchemy tournament Open',
      'Golden Chest',
      'From: Bob Time left: 2h 0m',
      'Source: Bank Open',
    ].join('\n');
    const cards = parseGiftCards(text);
    expect(cards).toHaveLength(2);
    expect(cards[0].chestName).toBe('Prepared alchemical cauldron');
    expect(cards[0].playerName).toBe('Alice');
    expect(cards[0].source).toBe('Alchemy tournament');
    expect(cards[1].chestName).toBe('Golden Chest');
    expect(cards[1].playerName).toBe('Bob');
    expect(cards[1].source).toBe('Bank');
  });

  it('recovers an inline name when OCR merges name + From onto one line', () => {
    const text = 'Golden Chest From: Bob Time left: 2h 0m Source: Bank Open';
    const cards = parseGiftCards(text);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      playerName: 'Bob',
      chestName: 'Golden Chest',
      source: 'Bank',
    });
  });

  it('tolerates Tesseract misreads of From/Source/Time markers', () => {
    const text = [
      'Runic Chest',
      'trom: Zoe Tome left: 3h 15m',
      's0urce: Citadel oper',
    ].join('\n');
    const cards = parseGiftCards(text);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      playerName: 'Zoe',
      chestName: 'Runic Chest',
      source: 'Citadel',
      timeLeft: '3h15m',
    });
  });

  it('returns no cards for an empty / "No gifts" panel', () => {
    expect(parseGiftCards('No gifts')).toHaveLength(0);
    expect(parseGiftCards('')).toHaveLength(0);
  });

  it('does not invent phantom cards from button text or OCR noise', () => {
    const text = [
      'Delete expired chests',
      'Claim chests',
      '@#$%',
      '17h 49m',
    ].join('\n');
    expect(parseGiftCards(text)).toHaveLength(0);
  });

  it('drops a card whose player name is unreadable garbage', () => {
    const text = [
      'Fire Chest',
      'From: 0 Time left: 1h 0m',
      'Source: Crypt Open',
    ].join('\n');
    // Single "0" is rejected as a player name, so no card is emitted.
    expect(parseGiftCards(text)).toHaveLength(0);
  });
});
