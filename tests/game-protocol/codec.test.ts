import { describe, expect, it } from 'vitest';
import {
  WireReader,
  decodeFrames,
  decodeValue,
  encodeFrame,
  encodeValues,
  messages,
  pushedEvents,
  type Wire,
} from '../../src/game-protocol/codec.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('game protocol codec — little-endian MessagePack', () => {
  it('encodes multi-byte numbers little-endian, smallest form first', () => {
    // [24204, 5] — a real reply head: cd 8c5e is 0x5e8c in LE.
    expect(encodeValues([[24204, 5]]).toString('hex')).toBe('92cd8c5e05');
    expect(encodeValues([127, 128, 255, 256]).toString('hex')).toBe('7fcc80ccffcd0001');
    expect(encodeValues([1794416412]).toString('hex')).toBe('ce1c9ff46a');
    expect(encodeValues([4599909976661]).toString('hex')).toBe('cf550a00002f040000');
    expect(encodeValues([-1, -33, -200]).toString('hex')).toBe('ffd0dfd138ff');
  });

  it('round-trips every value shape the game uses', () => {
    const values: Wire[] = [
      null, true, false, 0, 7, 300, 70000, 4599909976661, -5, -40000, 1.5,
      '', 'tb:117471041', 'x'.repeat(40), 'ü'.repeat(200),
      [], [1, [2, [3]]], Array.from({ length: 20 }, (_, i) => i),
      { 1: 'a', 20: [1, 2] },
      { $bin: 12, hex: '6afb8b35b45e5168c402a910' },
      { $pairs: [[[1001, 1], 1794416412], [[1003, 1], 5]] },
      '12800362303446015955n',
    ];
    for (const v of values) {
      expect(decodeValue(encodeValues([v])), JSON.stringify(v)).toEqual(v);
    }
  });

  it('decodes a real batch reply with nested frames', () => {
    // [2, 12] batch of 3: [13013,9] [20, 0xffffffff] · [240650,10] [{}] · [75000,11] [false]
    const buf = hex(`
      42000000 42000000 92020c03
      14000000 14000000 92cdd53209 9214ceffffffff
      11000000 11000000 92ce0aac03000a 9180
      11000000 11000000 92cef82401000b 91c2`);
    const frames = decodeFrames(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(2);
    expect(frames[0].seq).toBe(12);
    const msgs = messages(frames);
    expect(msgs.map((m) => [m.type, m.seq])).toEqual([[13013, 9], [240650, 10], [75000, 11]]);
    expect(msgs[0].body).toEqual([[20, 4294967295]]);
    expect(msgs[1].body).toEqual([[{}]]);
    expect(msgs[2].body).toEqual([[false]]);
  });

  it('separates pushed events (bytes past replyLen) from the reply', () => {
    const reply = encodeFrame([318, 136], [[1794869064]]);
    const eventBody = encodeValues([[{ $bin: 12, hex: '6afabe335f5c85a6f995c23a' }, 15546, 1794869063, 100003], [[1116913731704]]]);
    const event = Buffer.alloc(4 + eventBody.length);
    event.writeUInt32LE(event.length, 0);
    eventBody.copy(event, 4);
    const total = Buffer.concat([reply, event]);
    total.writeUInt32LE(total.length, 0); // len covers the trailer; replyLen stays the reply's
    const frames = decodeFrames(total);
    expect(frames[0].type).toBe(318);
    expect(frames[0].body).toEqual([[1794869064]]);
    expect(pushedEvents(frames)).toEqual([
      { oid: '6afabe335f5c85a6f995c23a', evType: 15546, ts: 1794869063, code: 100003, body: [[[1116913731704]]] },
    ]);
  });

  it('builds request frames whose header lengths cover the whole frame', () => {
    const f = encodeFrame([312, 28, [[4599909976661], { $bin: 12, hex: '00'.repeat(12) }], ''], [[[1327], [0], [], []]]);
    expect(f.readUInt32LE(0)).toBe(f.length);
    expect(f.readUInt32LE(4)).toBe(f.length);
    const [m] = messages(decodeFrames(f));
    expect([m.type, m.seq]).toEqual([312, 28]);
    expect(m.body).toEqual([[[1327], [0], [], []]]);
  });

  it('skips values without building them', () => {
    const buf = encodeValues([[{ a: [1, 2, 'x'.repeat(300)] }, { $bin: 12, hex: 'ab'.repeat(12) }, -70000, 'end']]);
    const r = new WireReader(buf);
    expect(r.arrayLength()).toBe(4);
    r.skip();
    r.skip();
    r.skip();
    expect(r.value()).toBe('end');
    expect(r.done).toBe(true);
  });
});
