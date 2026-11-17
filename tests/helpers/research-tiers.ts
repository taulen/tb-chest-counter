// Seed members' research the way a scan does, so troop tiers (and the guards
// level) come out of the real code path: a miniature of the game's research
// trees on disk (GAME_STATIC_DIR → <version>/tech-trees.json, what
// cachedTechTrees reads), and saveTechs for each read.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../../src/data/database.js';
import { saveTechs } from '../../src/data/repositories/game-protocol-repo.js';
import { resetTechTreesMemo, type TechTree, type TechTrees } from '../../src/game-protocol/tech-trees.js';
import { invalidate } from '../../src/utils/ttl-cache.js';

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Tech id of the Guardsmen unlock for tier 1–9 (8 and 9 sit in the "II" tree). */
export function guardsTech(tier: number): number {
  return 9000 + tier;
}

function node(techId: number, name: string): TechTree['nodes'][number] {
  return { techId, name, description: '', icon: '', maxLevel: 1, col: 0, row: 0, requires: [] };
}

function tree(id: number, name: string, nodes: TechTree['nodes']): TechTree {
  return { id, name, description: '', kind: 'research', tab: 'Unlock', icon: '', layout: '', nodes };
}

const TREES: TechTrees = {
  version: 'test-trees',
  builtAt: '2026-11-01T00:00:00.000Z',
  trees: [
    // Guardsmen I: Archers I … VII are tiers 1–7.
    tree(1, 'Guardsmen I', [1, 2, 3, 4, 5, 6, 7].map((t) => node(guardsTech(t), `Archers ${ROMAN[t]}`))),
    // Guardsmen II: numerals restart, + 7.
    tree(23, 'Guardsmen II', [node(guardsTech(8), 'Smiter I'), node(guardsTech(9), 'Smiter II')]),
  ],
};

/** Put the fixture trees where cachedTechTrees looks. Returns the undo. */
export function useResearchTrees(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-trees-'));
  fs.mkdirSync(path.join(dir, 'v1'));
  fs.writeFileSync(path.join(dir, 'v1', 'tech-trees.json'), JSON.stringify(TREES));
  const before = process.env.GAME_STATIC_DIR;
  process.env.GAME_STATIC_DIR = dir;
  resetTechTreesMemo();
  return () => {
    if (before === undefined) delete process.env.GAME_STATIC_DIR;
    else process.env.GAME_STATIC_DIR = before;
    resetTechTreesMemo();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

/** Link a member to a game player id (what member-sync does). */
export function linkPlayer(memberId: number, playerId: number): void {
  getDb().prepare('UPDATE members SET game_player_id = ? WHERE id = ?').run(playerId, memberId);
}

/**
 * One research read of `playerId` at `at` (ISO) showing Guardsmen tier `tier`
 * (every unlock up to it researched), plus a daily city snapshot for the read.
 * Drops the caches so the next read sees it.
 */
export function readResearch(clanId: number, playerId: number, tier: number, at: string, gameDate: string): void {
  const techs: Record<string, number> = { 1: 3 }; // a non-unit tech, as every city has
  for (let t = 1; t <= tier; t++) techs[guardsTech(t)] = 1;
  saveTechs(clanId, playerId, techs, at);
  getDb().prepare(
    `INSERT OR REPLACE INTO game_city_snapshots (clan_id, player_id, game_date, captured_at, tech_count, buildings, hero)
     VALUES (?, ?, ?, ?, ?, '{}', '{}')`,
  ).run(clanId, playerId, gameDate, at, Object.keys(techs).length);
  invalidate('');
}
