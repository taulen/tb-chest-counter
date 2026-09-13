"use strict";
// Measure the real round-trip time to the admin's browser.
//
// This replaced guessing from the client's IP address, which cannot work:
//
//  - IPv6 has no NAT. An ISP delegates a globally-routable prefix to the
//    home router, so a laptop on the same LAN as the server has a PUBLIC
//    address (e.g. 2a0d:9c42:…). "Not in a private range" says nothing
//    about whether it's local.
//  - Matching the client against our own interface subnets doesn't rescue
//    it either: we run in Docker, so our interfaces are the bridge network
//    (172.x), never the operator's LAN.
//
// A WebSocket ping/pong measures the property we actually want — how fast
// is this link — and is indifferent to IPv4 vs IPv6, NAT, VPNs, containers
// and reverse proxies alike.
Object.defineProperty(exports, "__esModule", { value: true });
exports.measureSocketRtt = measureSocketRtt;
/** One ping. Resolves with the RTT in ms, or null if it didn't come back. */
function pingOnce(ws, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const started = process.hrtime.bigint();
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            ws.off('pong', onPong);
            resolve(value);
        };
        const onPong = () => finish(Number(process.hrtime.bigint() - started) / 1e6);
        const timer = setTimeout(() => finish(null), timeoutMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        ws.on('pong', onPong);
        try {
            ws.ping();
        }
        catch {
            // Socket already gone — the timeout path resolves null.
        }
    });
}
/**
 * Median RTT over `samples` pings, or null if none came back.
 *
 * Median rather than mean so one scheduling hiccup or a retransmit can't
 * drag a genuinely fast link into the frugal profile.
 *
 * Cost is bounded: on a LAN this is a few milliseconds total; on a bad link
 * each sample is capped at `timeoutMs`.
 */
async function measureSocketRtt(ws, samples = 3, timeoutMs = 1_000) {
    const results = [];
    for (let i = 0; i < samples; i++) {
        if (ws.readyState !== 1)
            break; // OPEN
        const rtt = await pingOnce(ws, timeoutMs);
        if (rtt !== null)
            results.push(rtt);
    }
    if (results.length === 0)
        return null;
    results.sort((a, b) => a - b);
    return results[Math.floor(results.length / 2)];
}
//# sourceMappingURL=rtt.js.map