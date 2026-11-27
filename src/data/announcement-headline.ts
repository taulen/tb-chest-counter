/**
 * A clan announcement's headline: one line that says what it is about, for My
 * Clan → Announcements and the strip above My Clan's tabs
 * (docs/battle-reports.md). Rule-based, from the text itself — the leaders'
 * own words, their capitals kept:
 *
 *  1. Lines that only greet ("HELLO CHAOS!", "Hey family,", "Hello, my dear
 *     Chaos family,") and one- or two-word exclamations ("CHAOS FAMILY!!")
 *     are skipped while more text follows.
 *  2. A greeting that runs into the text ("Dear Chaos, we had a great time…")
 *     loses its greeting.
 *  3. The first sentence of the line that is left, without markdown stars or a
 *     trailing colon, cut at a word near MAX_LENGTH characters.
 *
 * Tuned on the 21 announcements the clans had shared by Nov 27 2026.
 */

export const HEADLINE_MAX_LENGTH = 100;

const GREETING = /^(hello|hi|hey|hiya|heya|dear|greetings|good (morning|afternoon|evening|day)|привет|здравствуйте|всем привет|hola|buenos d[ií]as|salut|bonjour|hallo|moin|ciao|ol[aá]|merhaba)\b/i;
const EDGE = /^[\s•·\-–—*_~=#>|.:]+|[\s•·\-–—*_~=#|]+$/g;

const words = (s: string) => s.split(/\s+/).filter(Boolean);

function isGreetingOnly(line: string): boolean {
  const n = words(line).length;
  if (GREETING.test(line) && n <= 6 && !/[.?]\s+\S/.test(line)) return true;
  // "CHAOS FAMILY!!", "Friends!"
  return n <= 2 && /!+$/.test(line);
}

/** "Dear Chaos, we had a great time…" → "We had a great time…"; unchanged when the line doesn't open with a greeting clause. */
function withoutGreeting(line: string): string {
  if (!GREETING.test(line)) return line;
  const m = /^(.{1,40}?)(,|\s[-–—]|!)\s+(.+)$/.exec(line);
  if (!m || words(m[1]).length > 5 || words(m[3]).length < 3) return line;
  return m[3];
}

function firstSentence(line: string): string {
  if (line.length <= HEADLINE_MAX_LENGTH) return line;
  const m = /^(.+?[.!?…]+)(\s|$)/.exec(line);
  return m && m[1].length >= 12 ? m[1] : line;
}

function cut(line: string): string {
  if (line.length <= HEADLINE_MAX_LENGTH) return line;
  const room = line.slice(0, HEADLINE_MAX_LENGTH);
  const at = room.lastIndexOf(' ');
  return `${(at > HEADLINE_MAX_LENGTH / 2 ? room.slice(0, at) : room).replace(/[\s,;:–—-]+$/, '')}…`;
}

/** The headline, or '' for an empty announcement. */
export function announcementHeadline(text: string): string {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\*+([^*]+)\*+/g, '$1').replace(/\s+/g, ' ').replace(EDGE, '').trim())
    .filter(Boolean);
  if (!lines.length) return '';
  let i = 0;
  while (i < lines.length - 1 && isGreetingOnly(lines[i])) i++;
  let line = withoutGreeting(lines[i]);
  line = firstSentence(line).replace(/:+$/, '').trim();
  if (/^\p{Ll}/u.test(line)) line = line[0].toUpperCase() + line.slice(1);
  return cut(line);
}
