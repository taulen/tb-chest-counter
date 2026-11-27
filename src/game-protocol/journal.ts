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
import WebSocket from 'ws';
import { decodeJournalValues, encodeValues, type BinValue, type Wire } from './codec.js';
import { GameProtocolError } from './client.js';

export const JOURNAL_URL = 'wss://journal-feed-kafka.totalbattle.com//';
const REQUEST_KEY = 2002062134;
const REPLY_KEY = 733765024;

export const JOURNAL_METHOD = {
  sharedEntry: 1129936016,
  items: 2663587727,
  ping: 2485168634,
} as const;

const CALL_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 15_000;

const binOf = (buf: Buffer): BinValue => ({ $bin: buf.length, hex: buf.toString('hex') });
const isRecord = (v: unknown): v is Record<string, Wire> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One request frame, byte for byte what the game client sends. */
export function encodeJournalRequest(method: number, seq: number, args: Wire[]): Buffer {
  return encodeValues([[{ [REQUEST_KEY]: binOf(encodeValues([[method, seq], 0])) }], args]);
}

export interface JournalReply {
  seq: number;
  status: number;
  error: string;
  body: Wire;
}

/** A reply frame, or null when it isn't one (an unsolicited push). */
export function decodeJournalReply(buf: Buffer): JournalReply | null {
  const [head, body] = decodeJournalValues(buf);
  const entry = Array.isArray(head) ? head[0] : undefined;
  if (!isRecord(entry)) return null;
  const header = entry[String(REPLY_KEY)];
  if (!header || typeof header !== 'object' || !('hex' in header)) return null;
  // The reply header's bin is one array, [seq, status, error] (the request's is two values).
  const decoded = decodeJournalValues(Buffer.from((header as BinValue).hex, 'hex'));
  const fields = Array.isArray(decoded[0]) ? decoded[0] : decoded;
  const [seq, status, error] = fields;
  if (typeof seq !== 'number') return null;
  return { seq, status: typeof status === 'number' ? status : -1, error: typeof error === 'string' ? error : '', body: body ?? null };
}

/**
 * The token goes into the URL as the client puts it: the game hands it out
 * already URL-encoded (`%3D` padding), so it is used as is; a plain one is encoded.
 */
export function journalUrl(token: string): string {
  return `${JOURNAL_URL}?token=${/%[0-9a-f]{2}/i.test(token) ? token : encodeURIComponent(token)}`;
}

/** An open journal connection: calls go out one at a time and wait for their reply. */
export class JournalSession {
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (r: JournalReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      let reply: JournalReply | null;
      try {
        reply = decodeJournalReply(buf);
      } catch {
        return; // not a reply we can read (a push): ignored
      }
      if (!reply) return;
      const w = this.waiting.get(reply.seq);
      if (!w) return;
      clearTimeout(w.timer);
      this.waiting.delete(reply.seq);
      w.resolve(reply);
    });
    ws.on('close', () => this.failAll(new GameProtocolError('journal socket closed')));
    ws.on('error', (err) => this.failAll(new GameProtocolError(`journal socket: ${err.message}`)));
  }

  static open(token: string): Promise<JournalSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(journalUrl(token), { origin: 'https://totalbattle.com' });
      const timer = setTimeout(() => { ws.terminate(); reject(new GameProtocolError('journal socket timed out')); }, OPEN_TIMEOUT_MS);
      ws.once('open', () => { clearTimeout(timer); ws.removeAllListeners('unexpected-response'); resolve(new JournalSession(ws)); });
      ws.once('error', (err) => { clearTimeout(timer); reject(new GameProtocolError(`journal socket: ${err.message}`)); });
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        ws.terminate();
        reject(new GameProtocolError(`journal socket refused: HTTP ${res.statusCode}`));
      });
    });
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const [seq, w] of this.waiting) {
      clearTimeout(w.timer);
      this.waiting.delete(seq);
      w.reject(err);
    }
  }

  call(method: number, args: Wire[], timeoutMs = CALL_TIMEOUT_MS): Promise<JournalReply> {
    if (this.closed) return Promise.reject(new GameProtocolError('journal socket closed'));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(seq);
        reject(new GameProtocolError(`journal call ${method} timed out`));
      }, timeoutMs);
      this.waiting.set(seq, { resolve, reject, timer });
      this.ws.send(encodeJournalRequest(method, seq, args), { binary: true }, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.waiting.delete(seq);
        reject(new GameProtocolError(`journal send: ${err.message}`));
      });
    });
  }

  close(): void {
    this.closed = true;
    this.ws.removeAllListeners('close');
    this.ws.on('error', () => {});
    try { this.ws.close(); } catch { /* already gone */ }
    this.failAll(new GameProtocolError('journal socket closed'));
  }
}

/** What opening a shared report answered. */
export type SharedEntryResult =
  | { ok: true; at: number; type: string; report: Buffer }
  | { ok: false; status: number; error: string };

/** A shared report's bytes by its chat link's `journalV2EntryId`. */
export async function fetchSharedEntry(session: JournalSession, entryId: string): Promise<SharedEntryResult> {
  const reply = await session.call(JOURNAL_METHOD.sharedEntry, [entryId]);
  if (reply.status !== 0) return { ok: false, status: reply.status, error: reply.error };
  const body = reply.body;
  const bins = Array.isArray(body) && Array.isArray(body[2]) ? body[2] : [];
  const first = bins[0];
  if (!Array.isArray(body) || typeof body[0] !== 'number' || typeof body[1] !== 'string' || !first || typeof first !== 'object' || !('hex' in first)) {
    return { ok: false, status: -1, error: 'no report in the reply' };
  }
  return { ok: true, at: body[0], type: body[1], report: Buffer.from((first as BinValue).hex, 'hex') };
}

/** One journal item (a battle's strike log) by id, or null when the reply has none. */
export async function fetchJournalItem(session: JournalSession, entryId: string, itemId: string): Promise<Buffer | null> {
  const reply = await session.call(JOURNAL_METHOD.items, [entryId, [itemId]]);
  const map = reply.status === 0 && Array.isArray(reply.body) ? reply.body[0] : null;
  if (!isRecord(map)) return null;
  const rows = map[itemId];
  const bin = Array.isArray(rows) ? rows[0] : null;
  return bin && typeof bin === 'object' && 'hex' in bin ? Buffer.from((bin as BinValue).hex, 'hex') : null;
}
