import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { classifyGameClient, describeNavFailure, detectGameClient } from '../../src/browser/game-client.js';

// Header text exactly as the full-page OCR read it on 2026-11-04.
const NEW_CLIENT_HEADER = 'Community Download STORE OFFICIAL BATTLE TOTALL Switch to classic version Support Account Logout English';
const CLASSIC_HEADER = 'Community Download STORE OFFICIAL BATTLE TOTALE Switch to new version Support Account Logout English';

describe('classifyGameClient', () => {
  it('reads the link to the OTHER client', () => {
    expect(classifyGameClient(NEW_CLIENT_HEADER)).toBe('new');
    expect(classifyGameClient(CLASSIC_HEADER)).toBe('classic');
  });

  it('is unknown when the header is absent or in another language', () => {
    expect(classifyGameClient('')).toBe('unknown');
    expect(classifyGameClient('Cambiar a la versión clásica')).toBe('unknown');
  });

  it('tolerates line breaks and case from innerText', () => {
    expect(classifyGameClient('switch to\nCLASSIC version')).toBe('new');
  });
});

describe('detectGameClient', () => {
  it('degrades to unknown when the page cannot be read', async () => {
    const page = { evaluate: () => Promise.reject(new Error('Target closed')) } as unknown as Page;
    await expect(detectGameClient(page)).resolves.toBe('unknown');
  });

  it('classifies the page text', async () => {
    const page = { evaluate: () => Promise.resolve(NEW_CLIENT_HEADER) } as unknown as Page;
    await expect(detectGameClient(page)).resolves.toBe('new');
  });
});

describe('describeNavFailure', () => {
  it('keeps the original message when the client is not the cause', () => {
    expect(describeNavFailure('classic')).toBe('Could not verify Gifts tab after 3 attempts');
    expect(describeNavFailure('unknown')).toBe('Could not verify Gifts tab after 3 attempts');
  });

  it('names the new client and the fix', () => {
    const msg = describeNavFailure('new');
    expect(msg.startsWith('Could not verify Gifts tab after 3 attempts')).toBe(true);
    expect(msg).toMatch(/new client/i);
    expect(msg).toMatch(/classic version/i);
  });
});
