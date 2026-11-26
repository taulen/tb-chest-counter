// When each research tree first showed up in the game's data, as far as this
// install has seen (src/game-protocol/tech-first-seen.ts): back-filled once
// from every cached copy (dated by its builtAt), then a new tree is dated by
// the read that finds it. Synthetic files in a temp dir.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIRST_SEEN_FILE, firstSeenFor } from '../../src/game-protocol/tech-first-seen.js';
import type { TechTrees } from '../../src/game-protocol/tech-trees.js';

let dir: string;
const tree = (id: number, techIds: number[], unplaced: number[] = []) => ({
  id, name: `T${id}`, description: '', kind: 'research' as const, tab: null, icon: '', layout: '',
  nodes: techIds.map((techId) => ({ techId, name: '', description: '', icon: '', maxLevel: 10, col: 0, row: 0, requires: [] })),
  unplaced: unplaced.map((techId) => ({ techId, name: '', description: '', icon: '', maxLevel: 10, requires: [] })),
});
const copy = (key: string, builtAt: string, trees: ReturnType<typeof tree>[], techs: number[] = []) => {
  fs.mkdirSync(path.join(dir, key), { recursive: true });
  fs.writeFileSync(path.join(dir, key, 'tech-trees.json'), JSON.stringify({ version: key, builtAt, trees }));
  fs.writeFileSync(path.join(dir, key, 'names.json'), JSON.stringify({ version: key, builtAt, techs: Object.fromEntries(techs.map((id) => [id, { name: '' }])) }));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-seen-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('firstSeenFor', () => {
  it('back-fills from the oldest copy on disk holding each tree and research', () => {
    copy('a', '2026-11-18T14:19:32.627Z', [tree(9, [9000])], [9000, 30000]);
    copy('b', '2026-11-26T02:23:46.622Z', [tree(9, [9000]), tree(28, [30088], [30000])]);
    const live: TechTrees = { version: 'b:art', builtAt: '2026-11-26T02:23:46.622Z', trees: [tree(9, [9000]), tree(28, [30088], [30000])] };
    const seen = firstSeenFor(live, dir, () => new Date('2026-11-26T05:00:00Z'));
    expect(seen.trees).toEqual({ 9: '2026-11-18T14:19:32.627Z', 28: '2026-11-26T02:23:46.622Z' });
    // A research in names.json before any tree listed it is dated by that copy.
    expect(seen.techs['30000']).toBe('2026-11-18T14:19:32.627Z');
    expect(fs.existsSync(path.join(dir, FIRST_SEEN_FILE))).toBe(true);
  });

  it('dates a tree it has never seen by the read that finds it, and keeps the old dates', () => {
    copy('a', '2026-11-18T14:19:32.627Z', [tree(9, [9000])]);
    firstSeenFor({ version: 'a:art', builtAt: '2026-11-18T14:19:32.627Z', trees: [tree(9, [9000])] }, dir);
    const seen = firstSeenFor(
      { version: 'c:art', builtAt: '2026-12-01T10:00:00.000Z', trees: [tree(9, [9000]), tree(40, [40000])] },
      dir,
      () => new Date('2026-12-01T12:00:00Z'),
    );
    expect(seen.trees).toEqual({ 9: '2026-11-18T14:19:32.627Z', 40: '2026-12-01T10:00:00.000Z' });
  });
});
