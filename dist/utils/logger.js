"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
exports.getLogger = getLogger;
exports.childLogger = childLogger;
const pino_1 = __importDefault(require("pino"));
const pino_pretty_1 = __importDefault(require("pino-pretty"));
const log_buffer_js_1 = require("./log-buffer.js");
let logger = null;
function createLogger(level = 'info') {
    if (logger)
        return logger;
    // Load any warnings from prior runs so the System page shows them
    // immediately on first paint after a restart.
    (0, log_buffer_js_1.loadPersistedEntries)();
    // Pretty-printed human-readable stream for stdout (what `docker logs`
    // shows). Same options the previous transport-based setup used.
    const prettyStream = (0, pino_pretty_1.default)({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
    });
    // Multistream lets us tee logs to multiple destinations with
    // per-destination level filters. Stdout gets everything at the
    // configured level; the in-app warning buffer only gets warn+.
    const streams = [
        { stream: prettyStream },
        { level: 'warn', stream: (0, log_buffer_js_1.createPinoSink)() },
    ];
    logger = (0, pino_1.default)({ level }, pino_1.default.multistream(streams));
    return logger;
}
function getLogger() {
    return logger ?? createLogger();
}
function childLogger(module) {
    return getLogger().child({ module });
}
//# sourceMappingURL=logger.js.map