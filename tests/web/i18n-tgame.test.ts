// tGame() in lib/i18n.js: the game's own names (GET /api/game-texts/<lang>)
// first, then the hand-kept `game` block, the ui dictionary and its patterns,
// then the English — and a page that loads whatever the game data does.

import { afterEach, describe, expect, it, vi } from 'vitest';

type FetchImpl = (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>;

const okJson = (texts: Record<string, string>): FetchImpl => async () => ({ ok: true, json: async () => ({ version: 'v1', lang: 'de', format: 1, texts }) });

async function loadI18n(lang: string, fetchImpl: FetchImpl) {
  vi.resetModules();
  vi.stubGlobal('localStorage', { getItem: () => lang, setItem: () => undefined });
  const spy = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', spy);
  const mod = await import('../../src/web/public/lib/i18n.js');
  return { ...mod, fetchSpy: spy };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tGame', () => {
  it("asks the server for the language's game texts once, at load", async () => {
    const { fetchSpy, getLanguage } = await loadI18n('de', okJson({}));
    expect(getLanguage()).toBe('de');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/game-texts/de');
  });

  it("puts the game's own text before the hand-kept block", async () => {
    const { tGame } = await loadI18n('de', okJson({ Ancients: 'Aus dem Spiel', 'Wooden Chest': 'Holztruhe' }));
    expect(tGame('Wooden Chest')).toBe('Holztruhe');
    expect(tGame('Ancients')).toBe('Aus dem Spiel');
  });

  it('fills {n} patterns, and finds stored spellings the game writes differently', async () => {
    const { tGame } = await loadI18n('de', okJson({
      'Level {n} Crypt': 'Gruft Level {n}',
      'Level {n}–{n} Vault of the Ancients': 'Schatzkammer der Ahnen Level {n}–{n}',
      'Wooden Chest': 'Holztruhe',
    }));
    expect(tGame('Level 25 Crypt')).toBe('Gruft Level 25');
    expect(tGame('Lvl 25-29 Vault of the Ancients')).toBe('Schatzkammer der Ahnen Level 25–29');
    expect(tGame('wooden  chest')).toBe('Holztruhe');
  });

  it('falls back to the hand-kept block, then the ui dictionary, then the English', async () => {
    const { tGame, t } = await loadI18n('de', okJson({}));
    expect(tGame('Ancients')).toBe('Aufstieg der Ahnen');
    expect(tGame('Leaderboard')).toBe(t('Leaderboard'));
    expect(tGame('Leaderboard')).not.toBe('Leaderboard');
    expect(tGame('Some Chest Nobody Translated')).toBe('Some Chest Nobody Translated');
    expect(tGame('')).toBe('');
    expect(tGame(null)).toBeNull();
  });

  it('renders with the hand-kept names when the game texts fail, are missing or never come', async () => {
    for (const failing of [
      async () => { throw new TypeError('offline'); },
      async () => ({ ok: false, status: 404, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }),
    ] as FetchImpl[]) {
      const { tGame } = await loadI18n('ru', failing);
      expect(tGame('Ancients')).toBe('Восстание Древних');
      expect(tGame('Wooden Chest')).toBe('Wooden Chest');
    }
  });

  it('stops waiting for the game texts after a moment', async () => {
    const hanging: FetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const started = Date.now();
    const { tGame } = await loadI18n('fr', hanging);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(tGame('Ancients')).toBe('Essor des Anciens');
  });

  it('asks for nothing in English and gives names back as they are', async () => {
    const { tGame, fetchSpy } = await loadI18n('en', okJson({ Ancients: 'x' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tGame('Ancients')).toBe('Ancients');
    expect(tGame('Level 25 Crypt')).toBe('Level 25 Crypt');
  });
});
