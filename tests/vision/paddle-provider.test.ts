import { describe, expect, it } from 'vitest';
import { regionsToText } from '../../src/vision/paddle-provider.js';
import { parseGiftCards } from '../../src/vision/gift-parser.js';
import { correctChestName } from '../../src/vision/chest-names.js';
import { classifyScreenStateText, parseMaintenanceDuration } from '../../src/vision/screen-state.js';
import { ScreenState } from '../../src/models/enums.js';

type R = { text: string; box: { x: number; y: number; width: number; height: number } };
const r = (text: string, x: number, y: number, w = 60, h = 24): R => ({ text, box: { x, y, width: w, height: h } });

describe('regionsToText (PaddleOCR region reconstruction)', () => {
  it('drops the "Clan" icon badge and orders rows top→bottom, left→right', () => {
    // Two-card layout; "Clan" badges sit at the far-left icon column.
    const regions: R[] = [
      r('Clan', 5, 10), r('RunicChest', 130, 10),
      r('From:Rune', 130, 40), r('Timeleft:18h54m', 700, 40),
      r('Source:Lvl30-34RaidRunicsquad', 130, 70), r('Open', 820, 70),
      r('Clan', 5, 140), r('ScorpionChest', 130, 140),
      r('From:NailPounder', 130, 170),
      r('Source:Level25epicCrypt', 130, 200),
    ];
    const text = regionsToText(regions);
    const lines = text.split('\n');
    expect(lines[0]).toBe('RunicChest');            // "Clan" dropped
    expect(lines[1]).toBe('From:Rune Timeleft:18h54m'); // left→right within row
    expect(lines[2]).toBe('Source:Lvl30-34RaidRunicsquad Open');
    expect(text).not.toMatch(/Clan/);
  });

  it('feeds through parseGiftCards to yield clean entries', () => {
    const regions: R[] = [
      r('Clan', 5, 10), r('RunicChest', 130, 10),
      r('From:Rune', 130, 40), r('Timeleft:18h54m', 700, 40),
      r('Source:Lvl30-34RaidRunicsquad', 130, 70), r('Open', 820, 70),
    ];
    const entries = parseGiftCards(regionsToText(regions));
    expect(entries).toHaveLength(1);
    expect(entries[0].chestName).toBe('Runic Chest');
    expect(entries[0].playerName).toBe('Rune');
    expect(entries[0].timeLeft).toBe('18h54m');
  });
});

describe('correctChestName — space-insensitive tier (PaddleOCR spaceless output)', () => {
  it('resolves spaceless names and strips a glued "Clan" badge prefix', () => {
    expect(correctChestName('RunicChest')).toBe('Runic Chest');
    expect(correctChestName('Clan RunicChest')).toBe('Runic Chest');
    expect(correctChestName("Gladiator'sChest")).toBe("Gladiator's Chest");
    expect(correctChestName('ScorpionChest')).toBe('Scorpion Chest');
  });

  it('prefers the LONGEST match so a shorter name does not swallow a longer one', () => {
    // "Common Chest of Wealth" is a substring of "Uncommon Chest of Wealth"
    // once spaces are stripped — longest-match must win.
    expect(correctChestName('UncommonChestofWealth')).toBe('Uncommon Chest of Wealth');
  });

  it('leaves genuinely unknown names untouched', () => {
    expect(correctChestName('Totally Made Up Thing')).toBe('Totally Made Up Thing');
  });
});

describe('classifyScreenStateText (shared, OCR-tolerant, space-insensitive)', () => {
  it('detects maintenance + parses duration from spaceless Paddle text', () => {
    const res = classifyScreenStateText('DearPlayers thegameisundergoingmaintenance willlastforabout1h30m');
    expect(res.state).toBe(ScreenState.MAINTENANCE);
    expect(res.maintenanceDurationMs).toBe((60 + 30) * 60_000);
  });

  it('detects NO_GIFTS even when the space is dropped', () => {
    expect(classifyScreenStateText('Nogifts').state).toBe(ScreenState.NO_GIFTS);
    expect(classifyScreenStateText('no gifts').state).toBe(ScreenState.NO_GIFTS);
  });

  it('detects GIFT_TAB via gift-card layout signals (spaceless)', () => {
    // No "gift" word — relies on the From/Source/Timeleft structural fallback.
    const res = classifyScreenStateText('RunicChest From:Rune Timeleft:18h54m Source:Lvl30Raid Open');
    expect(res.state).toBe(ScreenState.GIFT_TAB);
  });

  it('returns UNKNOWN for unrelated text', () => {
    expect(classifyScreenStateText('random map tile coordinates').state).toBe(ScreenState.UNKNOWN);
  });

  it('parseMaintenanceDuration handles minutes-only', () => {
    expect(parseMaintenanceDuration('will last for about 30 m')).toBe(30 * 60_000);
  });
});
