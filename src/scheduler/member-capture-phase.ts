// Member-capture phase of the scan cycle. Wraps the existing
// browser/member-capture.ts (which owns the OCR pipeline that reads
// the in-game members list) with the scheduler-level decisions:
//
//   * decide whether capture is needed for this clan,
//   * navigate to the clan panel before capture (the browser-layer
//     helper assumes the panel is already open),
//   * capture might + hero levels while the members list is still open
//     (same rows, same panel — see captureMightWhileMembersOpen),
//   * optionally pause for stdin so the operator can review names in
//     the admin UI before the first real scan,
//   * report the special "stop after member capture" sentinel so the
//     orchestrator can exit early.
//
// Pulled out of ScanLoop so runSingleScan reads as a sequence of
// numbered phases rather than 60 LOC of capture orchestration sitting
// inline.

import type { Page } from 'playwright';
import type { AppConfig } from '../models/types.js';
import { getCanvasBounds } from '../browser/navigator.js';
import { mouseClick } from '../browser/input.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('scanner');

export interface MemberCapturePhaseContext {
  config: AppConfig;
  clanId: number;
  skipMemberCapture: boolean;
  pauseAfterMemberCapture: boolean;
  stopAfterMemberCapture: boolean;
  reportProgress: (phase: 'member-capture', message: string) => void;
}

/**
 * Read might and hero levels straight after the roster build, while the
 * members list is still open.
 *
 * The member sweep has just scrolled every row of the panel that also carries
 * each member's might and level — leaving without them means a freshly
 * onboarded clan shows no might data until the next scan cycle reaches the
 * might phase, which on a first run can be hours away (and on the very first
 * cycle never happens at all: the might phase is skipped when a cycle runs
 * member capture only and never opens a scan session).
 *
 * Runs the real might phase rather than reimplementing it. That phase owns
 * everything that makes the numbers trustworthy — merge rules, matching a
 * reading to an existing member, promoting a genuinely new name with an
 * evidence crop, the hero-level vote — and none of that should exist twice.
 * The page is already on the Members tab, so its ensureOnMembersTab call
 * short-circuits instead of navigating again.
 *
 * Deliberately NOT forced: the once-a-day gate is left in charge, so a roster
 * rebuild on a day that already has a snapshot doesn't pay for a second sweep
 * to re-read numbers it holds.
 *
 * Best-effort, like the might phase is everywhere else — a failure here must
 * never fail the roster build that just succeeded.
 */
async function captureMightWhileMembersOpen(
  ctx: MemberCapturePhaseContext,
  page: Page,
): Promise<void> {
  try {
    const { runMightCapturePhase } = await import('./might-capture-phase.js');
    const outcome = await runMightCapturePhase({
      config: ctx.config,
      clanId: ctx.clanId,
      reportProgress: (message: string) => ctx.reportProgress('member-capture', message),
    }, page);

    if (outcome.ran) {
      log.info(`Captured might and hero levels for clan #${ctx.clanId} in the same pass as the roster.`);
    } else {
      log.info(
        `Might capture skipped after the roster build for clan #${ctx.clanId} (${outcome.skipped ?? 'no reason given'}).`,
      );
    }
  } catch (err) {
    log.warn(
      `Might capture after the roster build failed for clan #${ctx.clanId}: `
      + `${String(err instanceof Error ? err.message : err)}. The roster itself is unaffected.`,
    );
  }
}

export interface MemberCapturePhaseResult {
  /** True when the operator (or web-setup flag) requested the cycle
   *  stop here. The orchestrator should mark the scan as a successful
   *  no-op and return. */
  stopAfterCapture: boolean;
}

/**
 * Run the member-capture phase if this clan still needs it. No-op
 * (returns `stopAfterCapture: false`) when:
 *   - the caller passed `skipMemberCapture: true`, or
 *   - the clan already has captured members (`needsMemberCapture` is
 *     false for that clan).
 *
 * On capture, opens the clan panel, hands the page to the browser-layer
 * captureClanMembers, and then either pauses for stdin (CLI flow) or
 * continues automatically (web-setup flow). Returns `stopAfterCapture`
 * so the orchestrator can decide whether to short-circuit.
 */
export async function runMemberCapturePhase(
  ctx: MemberCapturePhaseContext,
  page: Page,
): Promise<MemberCapturePhaseResult> {
  const { needsMemberCapture, captureClanMembers } = await import('../browser/member-capture.js');
  if (ctx.skipMemberCapture || !needsMemberCapture(ctx.clanId)) {
    return { stopAfterCapture: false };
  }

  log.info('First run - capturing clan member list...');
  ctx.reportProgress('member-capture', 'Opening clan panel for member capture...');

  // Extra pause to ensure any residual popups/animations are fully gone
  // before clicking the clan button.
  await new Promise((r) => setTimeout(r, 4_000));

  // Navigate to clan panel first. These coords are the bottom-nav CLAN
  // button position; we don't go through calibration here because at
  // this point the operator may not have run calibration yet, and the
  // bottom-nav layout is the most stable reference point in the game.
  const canvasBounds = await getCanvasBounds(page);
  const clanCoords = {
    x: Math.round(canvasBounds.x + canvasBounds.width * 0.53),
    y: Math.round(canvasBounds.y + canvasBounds.height * 0.93),
  };
  await mouseClick(page, clanCoords.x, clanCoords.y);
  await new Promise((r) => setTimeout(r, 2000));

  await captureClanMembers(page, ctx.clanId, (message) =>
    ctx.reportProgress('member-capture', message));
  log.info('Member capture complete.');
  ctx.reportProgress('member-capture', 'Member capture complete.');

  await captureMightWhileMembersOpen(ctx, page);

  if (ctx.pauseAfterMemberCapture) {
    console.log('\n========================================');
    console.log('  MEMBER CAPTURE COMPLETE');
    console.log('========================================');
    console.log('  Review and fix member names in the dashboard:');
    console.log(`  http://localhost:${ctx.config.webPort}/#admin`);
    console.log('');
    console.log('  Press Enter when ready to start scanning...');
    console.log('========================================\n');
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve());
    });
  } else {
    log.info('Continuing automatically after member capture (web setup mode).');
  }

  if (ctx.stopAfterMemberCapture) {
    ctx.reportProgress('member-capture', 'Paused after member capture for manual review approval.');
    return { stopAfterCapture: true };
  }

  return { stopAfterCapture: false };
}
