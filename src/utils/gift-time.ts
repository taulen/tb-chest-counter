/**
 * Derive a gift's real in-game *received* time from the "time left" countdown
 * OCR'd off its card.
 *
 * Every Total Battle gift starts life with a fixed 20-hour claim window, and
 * the card shows how much of it remains. So the gift was received at
 *   received = (screenshotTime + timeLeft) − 20h
 * i.e. the moment the SCREENSHOT was taken (when the countdown was true) minus
 * however much of the 20h has already elapsed. It must be the screenshot time,
 * not scan-start or insert time: the scan screenshots batches over many seconds
 * and inserts them all later in the OCR phase, so keying off insert time would
 * shift every receipt later by up to the scan's duration — enough to misfile a
 * chest across the 17:00 game-day rollover. The game never displays the full
 * 20h00m (the timer has always ticked at least a second by the time a card
 * renders — the observed max is 19h59m), so 20h is the true starting lifetime.
 *
 * This exists because `captured_at` is the SCAN time, not the earn time: a
 * chest earned late in an event is only claimed by the first scan after the
 * event's reset, so scan-time attribution misfiles it. `earned_at` fixes that
 * for data collected going forward.
 *
 * Robustness first: this NEVER throws and NEVER blocks a scan. When the
 * countdown text isn't a clean `HHhMMm` (OCR garble, missing timer, a
 * days-scale value the parser can't represent, etc.) we fall back to
 * `fallbackMs` — pass the scan clock (captured_at) so a fallen-back row reads
 * earned_at == captured_at, which is how the health signals tell "captured"
 * from "fell back". A bad read degrades to current behaviour, never dropping
 * or corrupting the chest.
 */

/** Fixed starting lifetime of every gift's claim window. */
export const GIFT_LIFETIME_MS = 20 * 60 * 60 * 1000;

/**
 * Best-effort received-time (epoch ms) for a gift, from its `timeLeft`
 * (normalised "18h54m" form) and the SCREENSHOT time. On a clean read the
 * result is `screenshotMs + timeLeft − 20h` (always < screenshotMs, within the
 * last 20h). On any untrusted read it returns `fallbackMs` (defaults to
 * `screenshotMs`) — pass the scan/insert clock so fallbacks read earned == captured.
 */
export function giftEarnedAtMs(
  timeLeft: string,
  screenshotMs: number,
  fallbackMs: number = screenshotMs,
): number {
  if (!Number.isFinite(screenshotMs)) return fallbackMs;
  const m = typeof timeLeft === 'string' ? /^(\d{1,2})h(\d{1,2})m$/.exec(timeLeft.trim()) : null;
  if (m) {
    const hours = Number(m[1]);
    const mins = Number(m[2]);
    if (hours <= 20 && mins <= 59) {
      const remainingMs = (hours * 3600 + mins * 60) * 1000;
      // 0 = expired/garbage; > lifetime = impossible → fall through.
      if (remainingMs > 0 && remainingMs <= GIFT_LIFETIME_MS) {
        return screenshotMs + remainingMs - GIFT_LIFETIME_MS;
      }
    }
  }
  return fallbackMs;
}
