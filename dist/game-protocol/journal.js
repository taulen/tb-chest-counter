"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JournalSession = exports.JOURNAL_METHOD = exports.JOURNAL_URL = void 0;
exports.encodeJournalRequest = encodeJournalRequest;
exports.decodeJournalReply = decodeJournalReply;
exports.journalUrl = journalUrl;
exports.fetchSharedEntry = fetchSharedEntry;
exports.fetchJournalItem = fetchJournalItem;
/**
 * The game's journal service — where battle reports live — read the way the
 * game client reads it (recorded Nov 27 2026, docs/battle-reports.md).
 *
 *   1. The game login reply (203) carries a journal token: a JWT whose payload
 *      says `"aud": "Journal"` (journal-token.ts, GameClient.journalToken).
 *      It lives ~36 days.
 *   2. A WebSocket to wss://journal-feed-kafka.totalbattle.com//?token=<JWT>
 *      takes binary frames in the game's own encoding (little-endian
 *      MessagePack, codec.ts) with the journal's `0xc7` wrappers.
 *
 * A request is two values: `[{2002062134: bin([method, seq], 0)}]` and the
 * argument array. A reply is `[{733765024: bin(seq, status, error)}]` and its
 * body. Status 0 is success.
 *
 *   1129936016  [entryId]             a report shared in chat, by the
 *                                     `journalV2EntryId` of its chat link →
 *                                     [unix seconds, type, [bin(report)]].
 *                                     Works for ANY player's shared report,
 *                                     across realms (a realm 289 session
 *                                     opened realm 1071's, Nov 27 2026).
 *   2663587727  [entryId, [itemId]]   journal items by id → {itemId: [bin]}.
 *                                     A battle's strike log is one: its id is
 *                                     in the report (battle-report.ts).
 *   2485168634  []                    keep-alive (the client sends it every
 *                                     15 s; a short session needs none).
 *
 * Read-only: nothing here changes anything in the game.
 */
const ws_1 = __importDefault(require("ws"));
const codec_js_1 = require("./codec.js");
const client_js_1 = require("./client.js");
exports.JOURNAL_URL = 'wss://journal-feed-kafka.totalbattle.com//';
const REQUEST_KEY = 2002062134;
const REPLY_KEY = 733765024;
exports.JOURNAL_METHOD = {
    sharedEntry: 1129936016,
    items: 2663587727,
    ping: 2485168634,
};
const CALL_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 15_000;
const binOf = (buf) => ({ $bin: buf.length, hex: buf.toString('hex') });
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** One request frame, byte for byte what the game client sends. */
function encodeJournalRequest(method, seq, args) {
    return (0, codec_js_1.encodeValues)([[{ [REQUEST_KEY]: binOf((0, codec_js_1.encodeValues)([[method, seq], 0])) }], args]);
}
/** A reply frame, or null when it isn't one (an unsolicited push). */
function decodeJournalReply(buf) {
    const [head, body] = (0, codec_js_1.decodeJournalValues)(buf);
    const entry = Array.isArray(head) ? head[0] : undefined;
    if (!isRecord(entry))
        return null;
    const header = entry[String(REPLY_KEY)];
    if (!header || typeof header !== 'object' || !('hex' in header))
        return null;
    // The reply header's bin is one array, [seq, status, error] (the request's is two values).
    const decoded = (0, codec_js_1.decodeJournalValues)(Buffer.from(header.hex, 'hex'));
    const fields = Array.isArray(decoded[0]) ? decoded[0] : decoded;
    const [seq, status, error] = fields;
    if (typeof seq !== 'number')
        return null;
    return { seq, status: typeof status === 'number' ? status : -1, error: typeof error === 'string' ? error : '', body: body ?? null };
}
/**
 * The token goes into the URL as the client puts it: the game hands it out
 * already URL-encoded (`%3D` padding), so it is used as is; a plain one is encoded.
 */
function journalUrl(token) {
    return `${exports.JOURNAL_URL}?token=${/%[0-9a-f]{2}/i.test(token) ? token : encodeURIComponent(token)}`;
}
/** An open journal connection: calls go out one at a time and wait for their reply. */
class JournalSession {
    ws;
    seq = 0;
    waiting = new Map();
    closed = false;
    constructor(ws) {
        this.ws = ws;
        ws.on('message', (raw) => {
            const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
            let reply;
            try {
                reply = decodeJournalReply(buf);
            }
            catch {
                return; // not a reply we can read (a push): ignored
            }
            if (!reply)
                return;
            const w = this.waiting.get(reply.seq);
            if (!w)
                return;
            clearTimeout(w.timer);
            this.waiting.delete(reply.seq);
            w.resolve(reply);
        });
        ws.on('close', () => this.failAll(new client_js_1.GameProtocolError('journal socket closed')));
        ws.on('error', (err) => this.failAll(new client_js_1.GameProtocolError(`journal socket: ${err.message}`)));
    }
    static open(token) {
        return new Promise((resolve, reject) => {
            const ws = new ws_1.default(journalUrl(token), { origin: 'https://totalbattle.com' });
            const timer = setTimeout(() => { ws.terminate(); reject(new client_js_1.GameProtocolError('journal socket timed out')); }, OPEN_TIMEOUT_MS);
            ws.once('open', () => { clearTimeout(timer); ws.removeAllListeners('unexpected-response'); resolve(new JournalSession(ws)); });
            ws.once('error', (err) => { clearTimeout(timer); reject(new client_js_1.GameProtocolError(`journal socket: ${err.message}`)); });
            ws.once('unexpected-response', (_req, res) => {
                clearTimeout(timer);
                ws.terminate();
                reject(new client_js_1.GameProtocolError(`journal socket refused: HTTP ${res.statusCode}`));
            });
        });
    }
    failAll(err) {
        this.closed = true;
        for (const [seq, w] of this.waiting) {
            clearTimeout(w.timer);
            this.waiting.delete(seq);
            w.reject(err);
        }
    }
    call(method, args, timeoutMs = CALL_TIMEOUT_MS) {
        if (this.closed)
            return Promise.reject(new client_js_1.GameProtocolError('journal socket closed'));
        const seq = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(seq);
                reject(new client_js_1.GameProtocolError(`journal call ${method} timed out`));
            }, timeoutMs);
            this.waiting.set(seq, { resolve, reject, timer });
            this.ws.send(encodeJournalRequest(method, seq, args), { binary: true }, (err) => {
                if (!err)
                    return;
                clearTimeout(timer);
                this.waiting.delete(seq);
                reject(new client_js_1.GameProtocolError(`journal send: ${err.message}`));
            });
        });
    }
    close() {
        this.closed = true;
        this.ws.removeAllListeners('close');
        this.ws.on('error', () => { });
        try {
            this.ws.close();
        }
        catch { /* already gone */ }
        this.failAll(new client_js_1.GameProtocolError('journal socket closed'));
    }
}
exports.JournalSession = JournalSession;
/** A shared report's bytes by its chat link's `journalV2EntryId`. */
async function fetchSharedEntry(session, entryId) {
    const reply = await session.call(exports.JOURNAL_METHOD.sharedEntry, [entryId]);
    if (reply.status !== 0)
        return { ok: false, status: reply.status, error: reply.error };
    const body = reply.body;
    const bins = Array.isArray(body) && Array.isArray(body[2]) ? body[2] : [];
    const first = bins[0];
    if (!Array.isArray(body) || typeof body[0] !== 'number' || typeof body[1] !== 'string' || !first || typeof first !== 'object' || !('hex' in first)) {
        return { ok: false, status: -1, error: 'no report in the reply' };
    }
    return { ok: true, at: body[0], type: body[1], report: Buffer.from(first.hex, 'hex') };
}
/** One journal item (a battle's strike log) by id, or null when the reply has none. */
async function fetchJournalItem(session, entryId, itemId) {
    const reply = await session.call(exports.JOURNAL_METHOD.items, [entryId, [itemId]]);
    const map = reply.status === 0 && Array.isArray(reply.body) ? reply.body[0] : null;
    if (!isRecord(map))
        return null;
    const rows = map[itemId];
    const bin = Array.isArray(rows) ? rows[0] : null;
    return bin && typeof bin === 'object' && 'hex' in bin ? Buffer.from(bin.hex, 'hex') : null;
}
//# sourceMappingURL=journal.js.map