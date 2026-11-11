"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveClanScanSchedule = resolveClanScanSchedule;
function resolveClanScanSchedule(input) {
    const { clanId, now } = input;
    if (input.scanningClanId === clanId)
        return { scanning: true, nextScanAt: null };
    const pos = input.cycleOrder.indexOf(clanId);
    if (pos !== -1) {
        // Still ahead in this cycle: due now, it's just waiting for the clans
        // before it.
        if (pos > input.cycleCursor)
            return { scanning: false, nextScanAt: now };
        // Done this cycle (or in its post-scan phases). The real timer is armed
        // from the cycle's END, so a full interval from now is a lower bound that
        // corrects itself the moment the cycle finishes.
        return { scanning: false, nextScanAt: now + input.intervalMs };
    }
    return { scanning: false, nextScanAt: input.nextScanAt };
}
//# sourceMappingURL=clan-scan-schedule.js.map