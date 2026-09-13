"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.printScanReport = printScanReport;
exports.printDashboard = printDashboard;
const chestRepo = __importStar(require("../data/repositories/chest-repo.js"));
const sessionRepo = __importStar(require("../data/repositories/session-repo.js"));
function printScanReport(result) {
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
function printDashboard(clanId) {
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
//# sourceMappingURL=console-report.js.map