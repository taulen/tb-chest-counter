// Patch notes on disk (src/game-patch/notes.ts): the first run notes the
// newest patch against the one before it, a later patch is noted against the
// last one, the art landing after the data amends that patch, nothing moved =
// nothing written, a renamed chest the site stores is a warning. Synthetic
// files in a temp dir; texts from a stub (no network).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ warn: [] as string[] }));
vi.mock('../../src/utils/logger.js', () => ({
  childLogger: () => ({
    warn: (a: unknown, b?: unknown) => logged.warn.push(String(b ?? a)),
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { notePatch, patchList, patchNotesView, readNotesIndex, readPatchNotes, resetPatchNotesMemo } from '../../src/game-patch/notes.js';

let root: string;
let staticDir: string;
let artDir: string;
let notesDir: string;

const A = 'aaaaaaaaaaaaaaaa-cat1';
const B = 'bbbbbbbbbbbbbbbb-cat2';
const C = 'cccccccccccccccc-cat2';
const ART1 = '1'.repeat(32);
const ART2 = '2'.repeat(32);

function names(dir: string, version: string, builtAt: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(staticDir, dir), { recursive: true });
  fs.writeFileSync(path.join(staticDir, dir, 'names.json'), JSON.stringify({ version, builtAt, format: 12, gifts: {}, ...extra }));
}

function art(version: string, catalog: string[], images: string[] = []): void {
  fs.mkdirSync(path.join(artDir, version), { recursive: true });
  fs.writeFileSync(path.join(artDir, version, 'catalog-names.txt'), catalog.join('\n'));
  fs.writeFileSync(path.join(artDir, version, 'index.json'), JSON.stringify({
    version, images: Object.fromEntries(images.map((n) => [n, { file: `${n}.png`, w: 72, h: 72 }])), mappings: {},
  }));
}

const texts: Record<string, Map<string, string>> = {
  'cat1.json': new Map([['client.old.text', 'Old']]),
  'cat2.json': new Map([['client.old.text', 'Old'], ['client.new_temple.header.title', 'Temple'], ['client.new_temple.text', 'Revive your troops']]),
};
const fetchTexts = vi.fn(async (catalog: string, lang: string, keep?: ReadonlySet<string>) => {
  const all = texts[catalog];
  if (!all) throw new Error(`no ${catalog}`);
  if (lang === 'en') return new Map(all);
  return new Map([...all].filter(([k]) => !keep || keep.has(k)).map(([k, v]) => [k, `${lang}:${v}`]));
});
const catalogOf = (key: string): string | null => `${key.split('-')[1]}.json`;
const deps = (over: Record<string, unknown> = {}) => ({ staticDir, artDir, notesDir, fetchTexts, catalogOf, ...over });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-notes-'));
  staticDir = path.join(root, 'static');
  artDir = path.join(root, 'art');
  notesDir = path.join(root, 'notes');
  fs.mkdirSync(artDir, { recursive: true });
  resetPatchNotesMemo();
  fetchTexts.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('notePatch', () => {
  it('the first run notes the newest patch against the one before it on disk', async () => {
    names(A, A, '2026-11-20T21:09:09.599Z', { gifts: { 2080: { chest: "Koschei's Chest", source: '' } } });
    names(B, B, '2026-11-25T23:31:14.655Z', { gifts: { 2080: { chest: "Wyrm's Chest", source: '' }, 17146: { chest: 'Colosseum Blueprint', source: '' } } });
    art(ART1, ['old_icon', 'x']);
    art(ART2, ['old_icon', 'x', 'king_arthur_icon'], ['king_arthur_icon']);
    fs.writeFileSync(path.join(artDir, 'state.json'), JSON.stringify({ current: ART2, previous: ART1 }));

    const res = await notePatch(deps({ current: { names: B, art: ART2 } }));
    expect(res).toEqual({ status: 'noted', id: '2026-11-25-bbbbbbbb' });
    const n = readPatchNotes(res.id!, notesDir)!;
    expect(n.names).toEqual({ from: A, to: B });
    expect(n.art).toEqual({ from: ART1, to: ART2 });
    // Dated by when the patch was first read, not by this run.
    expect(n.date).toBe('2026-11-25T23:31:14.655Z');
    expect(n.sections[0].entries.map((e) => [e.kind, e.name])).toEqual([['added', 'Colosseum Blueprint'], ['renamed', "Wyrm's Chest"]]);
    expect(n.texts[0]).toMatchObject({ key: 'new_temple', title: { en: 'Temple', de: 'de:Temple' } });
    expect(n.images).toEqual([{ stem: 'king_arthur', names: ['king_arthur_icon'] }]);
    expect(readNotesIndex(notesDir)).toMatchObject({ names: B, art: ART2, patches: [{ id: res.id, counts: { gifts: 2, texts: 2, images: 1 } }] });

    // Nothing moved since: nothing written.
    expect(await notePatch(deps({ current: { names: B, art: ART2 } }))).toEqual({ status: 'unchanged' });
  });

  it('the first run skips a step of the same patch: it compares with the version of other static data', async () => {
    const SAME = 'bbbbbbbbbbbbbbbb-cat1'; // the patch's static data with the old translations, read in between
    names(A, A, '2026-11-20T21:09:09.599Z', { gifts: {} });
    names(SAME, SAME, '2026-11-25T22:00:00.000Z', { gifts: { 17146: { chest: 'Colosseum Blueprint', source: '' } } });
    names(B, B, '2026-11-25T23:31:14.655Z', { gifts: { 17146: { chest: 'Colosseum Blueprint', source: '' } } });
    const res = await notePatch(deps({ current: { names: B, art: null } }));
    expect(readPatchNotes(res.id!, notesDir)!.names).toEqual({ from: A, to: B });
    expect(readPatchNotes(res.id!, notesDir)!.sections[0].entries[0].name).toBe('Colosseum Blueprint');
  });

  it('the first run skips identical data re-published under a new hash: it compares by content', async () => {
    const REPUB = 'dddddddddddddddd-cat2'; // other static hash, same translations, same content
    names(A, A, '2026-11-20T21:09:09.599Z', { gifts: {} });
    names(REPUB, REPUB, '2026-11-25T22:00:00.000Z', { gifts: { 17146: { chest: 'Colosseum Blueprint', source: '' } } });
    names(B, B, '2026-11-25T23:31:14.655Z', { gifts: { 17146: { chest: 'Colosseum Blueprint', source: '' } } });
    const res = await notePatch(deps({ current: { names: B, art: null } }));
    expect(readPatchNotes(res.id!, notesDir)!.names).toEqual({ from: A, to: B });
  });

  it('an index of an older format is noted afresh', async () => {
    names(A, A, '2026-11-20T21:09:09.599Z', { gifts: {} });
    names(B, B, '2026-11-25T23:31:14.655Z', { gifts: { 1: { chest: 'New', source: '' } } });
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'index.json'), JSON.stringify({ format: 1, names: B, art: null, patches: [{ id: 'old', date: 'x', counts: {}, highlights: [] }] }));
    const res = await notePatch(deps({ current: { names: B, art: null } }));
    expect(res.status).toBe('noted');
    expect(patchList(notesDir).map((p) => p.id)).toEqual([res.id]);
  });

  it('a fresh volume with nothing before it starts from here', async () => {
    names(B, B, '2026-11-25T23:31:14.655Z');
    expect(await notePatch(deps({ current: { names: B, art: null } }))).toEqual({ status: 'baseline' });
    expect(readNotesIndex(notesDir)).toMatchObject({ names: B, patches: [] });
  });

  it('a later patch is noted against the last one; the art landing after it amends it', async () => {
    names(A, A, '2026-11-20T21:09:09.599Z');
    names(B, B, '2026-11-25T23:31:14.655Z', { events: { '1038,1': { code: '', titleKey: 'k', title: 'CLAN DUEL' } } });
    fs.writeFileSync(path.join(staticDir, A, 'names.json'), JSON.stringify({ version: A, builtAt: '2026-11-20T21:09:09.599Z', gifts: {}, events: {} }));
    art(ART1, ['a', 'b']);
    art(ART2, ['a', 'b', 'xmas26_frame'], ['xmas26_frame']);
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'index.json'), JSON.stringify({ format: 1, names: A, art: ART1, patches: [] }));
    const now = new Date('2026-11-26T00:00:00Z');

    const first = await notePatch(deps({ current: { names: B, art: ART1 }, now: () => now }));
    expect(first.status).toBe('noted');
    expect(readPatchNotes(first.id!, notesDir)!.art).toBeNull();

    const later = new Date('2026-11-26T00:20:00Z');
    const second = await notePatch(deps({ current: { names: B, art: ART2 }, now: () => later }));
    expect(second).toEqual({ status: 'amended', id: first.id });
    const n = readPatchNotes(first.id!, notesDir)!;
    expect(n.art).toEqual({ from: ART1, to: ART2 });
    expect(n.sections.find((s) => s.key === 'events')!.entries[0].name).toBe('CLAN DUEL');
    expect(n.images.map((g) => g.stem)).toEqual(['xmas26_frame']);
    expect(patchList(notesDir)).toHaveLength(1);
  });

  it('a version move with nothing new in it notes nothing', async () => {
    names(B, B, '2026-11-25T23:31:14.655Z');
    names(C, C, '2026-11-26T10:00:00.000Z');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'index.json'), JSON.stringify({ format: 1, names: B, art: null, patches: [] }));
    expect(await notePatch(deps({ current: { names: C, art: null } }))).toEqual({ status: 'unchanged' });
    expect(readNotesIndex(notesDir)).toMatchObject({ names: C, patches: [] });
  });

  it("goes without texts when the CDN no longer has the old catalogue", async () => {
    names(A, A, '2026-11-20T21:09:09.599Z', { gifts: {} });
    names('dddddddddddddddd-gone', 'dddddddddddddddd-gone', '2026-11-25T23:31:14.655Z', { gifts: { 1: { chest: 'New', source: '' } } });
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'index.json'), JSON.stringify({ format: 1, names: A, art: null, patches: [] }));
    texts['gone.json'] = new Map();
    delete texts['cat1.json'];
    try {
      const res = await notePatch(deps({ current: { names: 'dddddddddddddddd-gone', art: null } }));
      const n = readPatchNotes(res.id!, notesDir)!;
      expect(n.textsError).toMatch(/no cat1.json/);
      expect(n.sections[0].entries[0].name).toBe('New');
    } finally {
      texts['cat1.json'] = new Map([['client.old.text', 'Old']]);
    }
  });

  it('warns when a renamed chest is stored under its old name', async () => {
    logged.warn.length = 0;
    names(A, A, '2026-11-20T21:09:09.599Z', { gifts: { 2080: { chest: "Koschei's Chest", source: '' } } });
    names(B, B, '2026-11-25T23:31:14.655Z', { gifts: { 2080: { chest: "Wyrm's Chest", source: '' } } });
    await notePatch(deps({ current: { names: B, art: null }, storedChests: (n: string[]) => new Map(n.map((x) => [x, 12])) }));
    expect(logged.warn.some((l) => l.includes("renamed the chest \"Koschei's Chest\" to \"Wyrm's Chest\"; 12 record(s)"))).toBe(true);
  });
});

describe('the page view', () => {
  it('resolves picture names to the current art and cuts texts to English + the reader\'s language', async () => {
    names(A, A, '2026-11-20T21:09:09.599Z', { gifts: {} });
    names(B, B, '2026-11-25T23:31:14.655Z', { gifts: { 17146: { chest: 'Colosseum Blueprint', source: '' } } });
    fs.writeFileSync(path.join(artDir, `static-${B}.json`), JSON.stringify({ version: B, items: [{ id: 17146, name: 'Colosseum Blueprint', icon: 'collosseum_blueprint' }] }));
    const res = await notePatch(deps({ current: { names: B, art: null } }));
    const artIndex = { version: ART2, images: { collosseum_blueprint: { file: 'collosseum_blueprint.png', w: 72, h: 72 } } };
    const view = patchNotesView(res.id!, 'ru', artIndex, notesDir) as {
      sections: Array<{ entries: Array<{ iconUrl: string | null; icon?: unknown }> }>;
      texts: Array<{ added: Array<{ text: Record<string, string> }> }>;
    };
    expect(view.sections[0].entries[0].iconUrl).toBe(`/game-art/${ART2}/collosseum_blueprint.png`);
    expect(view.sections[0].entries[0].icon).toBeUndefined();
    expect(Object.keys(view.texts[0].added[0].text).sort()).toEqual(['en', 'ru']);
    expect(patchNotesView('../etc', 'en', null, notesDir)).toBeNull();
  });
});
