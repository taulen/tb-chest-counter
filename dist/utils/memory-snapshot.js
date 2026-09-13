"use strict";
// A one-line memory reading for the moments where we'd otherwise be guessing.
//
// "Target crashed" is Chromium telling us a child process died without saying
// why, and by far the most common why in this container is the kernel's OOM
// killer picking the renderer — it is reliably the largest RSS in the cgroup,
// and killing it leaves Node alive and puzzled. Nothing in the logs
// distinguished that from a driver fault or a genuine browser bug, so a crash
// was undiagnosable after the fact.
//
// cgroup v2 answers it outright: memory.events counts `oom_kill`, so a snapshot
// taken at the crash tells us whether the kernel killed something inside this
// container, and memory.current/max says how close we were to the ceiling.
//
// Dependency-free and never throws: this runs on failure paths, where a
// diagnostic that can itself fail is worse than none.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.memorySnapshot = memorySnapshot;
const fs_1 = __importDefault(require("fs"));
const CGROUP_V2 = '/sys/fs/cgroup';
const CGROUP_V1_MEM = '/sys/fs/cgroup/memory';
function readNumber(file) {
    try {
        const raw = fs_1.default.readFileSync(file, 'utf8').trim();
        if (raw === 'max')
            return Infinity;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }
    catch {
        return null;
    }
}
/** Pull one `key value` pair out of a cgroup flat-keyed file (memory.events). */
function readKeyedValue(file, key) {
    try {
        for (const line of fs_1.default.readFileSync(file, 'utf8').split('\n')) {
            const [k, v] = line.trim().split(/\s+/);
            if (k === key) {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            }
        }
    }
    catch {
        // No cgroup file (not Linux, not containerised, cgroup v1) — caller copes.
    }
    return null;
}
function mb(bytes) {
    return `${Math.round(bytes / 1024 / 1024)}MB`;
}
/**
 * Sample process and container memory. Safe to call from any failure path.
 *
 * The cgroup fields are null off Linux / outside a container (local dev), in
 * which case the summary degrades to just the Node process figures.
 */
function memorySnapshot() {
    const rssBytes = process.memoryUsage.rss();
    let cgroupCurrentBytes = readNumber(`${CGROUP_V2}/memory.current`);
    let cgroupMaxBytes = readNumber(`${CGROUP_V2}/memory.max`);
    let oomKills = readKeyedValue(`${CGROUP_V2}/memory.events`, 'oom_kill');
    if (cgroupCurrentBytes === null) {
        // cgroup v1 layout.
        cgroupCurrentBytes = readNumber(`${CGROUP_V1_MEM}/memory.usage_in_bytes`);
        cgroupMaxBytes = readNumber(`${CGROUP_V1_MEM}/memory.limit_in_bytes`);
        oomKills = readKeyedValue(`${CGROUP_V1_MEM}/memory.oom_control`, 'oom_kill');
    }
    const parts = [`node rss=${mb(rssBytes)}`];
    if (cgroupCurrentBytes !== null) {
        const ceiling = cgroupMaxBytes === null || cgroupMaxBytes === Infinity ? 'unlimited' : mb(cgroupMaxBytes);
        parts.push(`container=${mb(cgroupCurrentBytes)}/${ceiling}`);
    }
    if (oomKills !== null)
        parts.push(`oom_kills=${oomKills}`);
    return {
        rssBytes,
        cgroupCurrentBytes,
        cgroupMaxBytes,
        oomKills,
        summary: parts.join(' '),
    };
}
//# sourceMappingURL=memory-snapshot.js.map