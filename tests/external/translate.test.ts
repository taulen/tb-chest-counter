// The chat translator: one stored line on request, the game's placeholders kept,
// cached per language, and a pause after the free endpoint refuses.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTranslateForTests, translateChatLine, TranslateUnavailableError } from '../../src/external/translate.js';

/** A fake endpoint answering each `q` from `answer` (text → [translation, detected language]). */
function fakeEndpoint(answer: (q: string) => [string, string] | string) {
  const calls: Array<{ url: string; qs: string[] }> = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const qs = new URLSearchParams(String(init?.body ?? '')).getAll('q');
    calls.push({ url: String(url), qs });
    return new Response(JSON.stringify(qs.map(answer)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe('translateChatLine', () => {
  afterEach(() => resetTranslateForTests());

  it('asks for the target language with auto-detection, POSTing the text, and reports the detected language', async () => {
    const { f, calls } = fakeEndpoint(() => ['good morning all', 'ru']);
    resetTranslateForTests(f);
    expect(await translateChatLine('7:0', 'доброе утро всем', 'en')).toEqual({ from: 'ru', text: 'good morning all' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('translate_a/t?client=gtx&sl=auto&tl=en');
    expect(calls[0].qs).toEqual(['доброе утро всем']);
  });

  it('sends a line once per language, then answers from the cache', async () => {
    const { f, calls } = fakeEndpoint((q) => [`[${q}]`, 'de']);
    resetTranslateForTests(f);
    await translateChatLine('7:0', 'Hallo', 'en');
    await translateChatLine('7:0', 'Hallo', 'en');
    expect(calls).toHaveLength(1);
    // Another language, or the same message after an edit, is a new request.
    await translateChatLine('7:0', 'Hallo', 'fr');
    await translateChatLine('7:99', 'Hallo zusammen', 'en');
    expect(calls).toHaveLength(3);
  });

  it('keeps the game placeholders; when the answer loses one, translates around it', async () => {
    const kept = fakeEndpoint(() => ['attack /%0%/ at 18', 'de']);
    resetTranslateForTests(kept.f);
    expect((await translateChatLine('1:0', 'Angriff /%0%/ um 18', 'en')).text).toBe('attack /%0%/ at 18');

    // The whole line came back without its chip: the pieces go separately.
    const lost = fakeEndpoint((q) => (q.includes('/%') ? ['attack at 18', 'de'] : [q === 'Angriff ' ? 'attack' : 'at 18', 'de']));
    resetTranslateForTests(lost.f);
    const tr = await translateChatLine('2:0', 'Angriff /%0%/ um 18', 'en');
    expect(tr).toEqual({ from: 'de', text: 'attack /%0%/ at 18' });
    expect(lost.calls[1].qs).toEqual(['Angriff ', ' um 18']);
  });

  it('pauses for a while after the endpoint refuses, without sending more', async () => {
    const f = vi.fn(async () => new Response('Too Many Requests', { status: 429 }));
    resetTranslateForTests(f as unknown as typeof fetch);
    await expect(translateChatLine('3:0', 'hola', 'en')).rejects.toThrow(/Translation failed: HTTP 429/);
    await expect(translateChatLine('4:0', 'bonjour', 'en')).rejects.toBeInstanceOf(TranslateUnavailableError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer in an unexpected shape', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    resetTranslateForTests(f as unknown as typeof fetch);
    await expect(translateChatLine('5:0', 'hola', 'en')).rejects.toBeInstanceOf(TranslateUnavailableError);
  });
});
