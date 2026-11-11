"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveClanScanSchedule = resolveClanScanSchedule;
const SCANNING = { scanning: true, due: false, nextScanInMs: null };
const DUE = { scanning: false, due: true, nextScanInMs: null };
const OFF = { scanning: false, due: false, nextScanInMs: null };
function resolveClanScanSchedule(input) {
    const { clanId, now } = input;
    if (input.scanningClanId === clanId)
        return SCANNING;
    const pos = input.cycleOrder.indexOf(clanId);
    if (pos !== -1) {
        // Done this cycle. The real timer is armed from the cycle's END, so a full
        // interval from now is a lower bound that corrects itself the moment the
        // cycle finishes.
        if (pos < input.cycleDoneCount)
            return { scanning: false, due: false, nextScanInMs: input.intervalMs };
        // Still ahead in this cycle — or up next with its browser still launching.
        return DUE;
    }
    if (input.nextScanAt === null)
        return OFF;
    const inMs = input.nextScanAt - now;
    return inMs > 0 ? { scanning: false, due: false, nextScanInMs: inMs } : DUE;
}
//# sourceMappingURL=clan-scan-schedule.js.map