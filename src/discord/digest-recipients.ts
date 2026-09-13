/**
 * The digest DM recipient list.
 *
 * It is stored in one TEXT column (`clans.discord_daily_digest_share_user_id`)
 * as a comma-separated list, so a database that holds a single bare ID from
 * before multi-recipient support parses to a one-element list with no
 * migration. Everything above the DB works in terms of the parsed array.
 *
 * Operators paste these out of Discord, so the parser is deliberately
 * forgiving about the shape of what lands in the field: commas, spaces and
 * newlines all separate, and a right-click "Copy User ID" that arrives as a
 * `<@123…>` mention is unwrapped rather than rejected.
 */

/** Discord snowflakes are 17–20 digits today; allow a little headroom. */
const SNOWFLAKE = /^\d{15,25}$/;

/**
 * A guard against a paste accident turning one digest into a DM storm —
 * each recipient is a separate REST call against a shared rate limit.
 */
export const MAX_DIGEST_RECIPIENTS = 20;

/**
 * Parse the stored/submitted value into de-duplicated Discord user IDs,
 * dropping anything that isn't a snowflake.
 */
export function parseDigestRecipients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of String(raw).split(/[\s,;]+/)) {
    if (!piece) continue;
    // `<@123…>` / `<@!123…>` — a mention pasted instead of a raw ID.
    const id = piece.replace(/^<@!?/, '').replace(/>$/, '').trim();
    if (!SNOWFLAKE.test(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_DIGEST_RECIPIENTS) break;
  }
  return out;
}

/**
 * Canonical storage form: the parsed IDs joined by ", ". Normalising on
 * save means the field the admin sees back is the field the bot will act
 * on — a typo'd entry disappears at save time instead of failing silently
 * once a day at rollover.
 */
export function normalizeDigestRecipients(raw: string | null | undefined): string {
  return parseDigestRecipients(raw).join(', ');
}
