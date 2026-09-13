import type { ScanResult } from '../scheduler/loop.js';
import * as chestRepo from '../data/repositories/chest-repo.js';
import * as sessionRepo from '../data/repositories/session-repo.js';

export function printScanReport(result: ScanResult): void {
  const count = result.giftsData.length;
  const triumphalCount = result.triumphalData?.length ?? 0;

  console.log('\n┌────────────────────────────────────────────────────┐');
  console.log('│                  SCAN REPORT                       │');
  console.log('├────────────────────────────────────────────────────┤');
  console.log(`│  Status:       ${(result.success ? 'SUCCESS' : 'FAILED').padEnd(35)}│`);
  console.log(`│  Chests:       ${String(count).padEnd(35)}│`);
  console.log(`│  Triumphal:    ${String(triumphalCount).padEnd(35)}│`);
  console.log(`│  Errors:       ${String(result.errors).padEnd(35)}│`);

  if (count > 0) {
    console.log('├────────────────────────────────────────────────────┤');
    for (const gift of result.giftsData) {
      const line = `  ${gift.playerName}: ${gift.chestName} (${gift.source})`;
      console.log(`│${line.slice(0, 51).padEnd(51)}│`);
    }
  }

  if (triumphalCount > 0) {
    console.log('├────────────────────────────────────────────────────┤');
    console.log(`│${'  TRIUMPHAL CHESTS'.padEnd(51)}│`);
    console.log('├────────────────────────────────────────────────────┤');
    for (const gift of result.triumphalData) {
      const line = `  ${gift.playerName}: ${gift.chestName} (${gift.source})`;
      console.log(`│${line.slice(0, 51).padEnd(51)}│`);
    }
  }

  console.log('└────────────────────────────────────────────────────┘\n');
}

export function printDashboard(clanId: number): void {
  const stats = sessionRepo.getScanStats(clanId);
  const leaderboard = chestRepo.getLeaderboard(clanId, undefined, undefined, { limit: 10 });
  const recent = chestRepo.getRecentChests(clanId, 5);

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       TB CHEST COUNTER DASHBOARD     ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Total Scans:   ${String(stats.totalSessions).padEnd(19)}║`);
  console.log(`║  Total Chests:  ${String(stats.totalChests).padEnd(19)}║`);
  console.log(`║  Total Members: ${String(stats.totalMembers).padEnd(19)}║`);
  console.log(`║  Avg/Scan:      ${String(stats.avgChestsPerScan).padEnd(19)}║`);
  if (stats.lastScanAt) {
    console.log(`║  Last Scan:     ${stats.lastScanAt.slice(0, 19).padEnd(19)}║`);
  }
  console.log('╠══════════════════════════════════════╣');

  if (leaderboard.length > 0) {
    console.log('║  LEADERBOARD                         ║');
    console.log('║  Rank  Player           Points       ║');
    console.log('║  ────  ──────           ──────       ║');
    for (const entry of leaderboard) {
      const rank = String(entry.rank).padEnd(4);
      const name = entry.memberName.slice(0, 16).padEnd(16);
      const points = String(entry.totalPoints).padEnd(6);
      console.log(`║  ${rank}  ${name} ${points}       ║`);
    }
  }

  if (recent.length > 0) {
    console.log('╠══════════════════════════════════════╣');
    console.log('║  RECENT CHESTS                       ║');
    for (const chest of recent) {
      const line = `  ${chest.playerName}: ${chest.chestName}`;
      console.log(`║${line.slice(0, 37).padEnd(37)}║`);
    }
  }

  console.log('╚══════════════════════════════════════╝\n');
}
