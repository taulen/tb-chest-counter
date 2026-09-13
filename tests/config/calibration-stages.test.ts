/**
 * Pins the wizard's per-stage checklist against the gate that actually blocks
 * scanning.
 *
 * Two things now read "is this stage done": the onboarding banner / System-page
 * checklist (via calibrationStageStatus) and the scan gate
 * (isFullyCalibrated). They are separate functions over the same config, so
 * they can disagree — and when they do, the operator gets a checklist with
 * every box ticked sitting beside a banner that still says calibration is
 * needed, with nothing on screen to say which one is wrong. That is the bug
 * this file exists to prevent, and it is exactly what a new required target
 * added to one and not the other would cause.
 *
 * Pure: sets the calibration env vars, resets the config cache, asserts. No DB,
 * no server, so it runs in `npm run build`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  calibrationStageStatus,
  isFullyCalibrated,
  requiredCalibrationProgress,
} from '../../src/config/calibration.js';
import { resetConfig } from '../../src/config/index.js';

// Every env var the required stages read, with a value that reads as "set".
const STAGE_ENV: Record<string, string[]> = {
  main: ['UI_CLAN_BUTTON_X_PCT', 'UI_CLAN_BUTTON_Y_PCT'],
  sidebars: [
    'UI_GIFTS_SIDEBAR_X_PCT', 'UI_GIFTS_SIDEBAR_Y_PCT',
    'UI_MEMBERS_SIDEBAR_X_PCT', 'UI_MEMBERS_SIDEBAR_Y_PCT',
  ],
  gifts: [
    'UI_GIFTS_TAB_X_PCT', 'UI_GIFTS_TAB_Y_PCT',
    'SCAN_OPEN_BUTTON_X_PCT', 'SCAN_OPEN_BUTTON_Y_PCT',
  ],
  members: [],
};

// Crops need right > left and bottom > top, so they can't use the flat value.
const STAGE_CROPS: Record<string, [string, string, string, string]> = {
  gifts: ['SCAN_CROP_LEFT_PCT', 'SCAN_CROP_TOP_PCT', 'SCAN_CROP_RIGHT_PCT', 'SCAN_CROP_BOTTOM_PCT'],
  members: [
    'MEMBER_LIST_CROP_LEFT_PCT', 'MEMBER_LIST_CROP_TOP_PCT',
    'MEMBER_LIST_CROP_RIGHT_PCT', 'MEMBER_LIST_CROP_BOTTOM_PCT',
  ],
};

const ALL_KEYS = [
  ...Object.values(STAGE_ENV).flat(),
  ...Object.values(STAGE_CROPS).flat(),
];

let saved: Record<string, string | undefined> = {};

function completeStage(key: string): void {
  for (const name of STAGE_ENV[key] ?? []) process.env[name] = '0.5';
  const crop = STAGE_CROPS[key];
  if (crop) {
    const [l, t, r, b] = crop;
    process.env[l] = '0.1';
    process.env[t] = '0.1';
    process.env[r] = '0.9';
    process.env[b] = '0.9';
  }
  resetConfig();
}

beforeEach(() => {
  saved = {};
  for (const name of ALL_KEYS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  resetConfig();
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetConfig();
});

describe('calibration stage status', () => {
  it('agrees with isFullyCalibrated once every required stage is done', () => {
    expect(isFullyCalibrated()).toBe(false);

    const required = calibrationStageStatus().filter((s) => s.required).map((s) => s.key);
    expect(required).toEqual(['main', 'sidebars', 'gifts', 'members']);

    for (const key of required) {
      completeStage(key);
      // isFullyCalibrated must not flip true before the LAST required stage —
      // if it does, this list claims a stage is required that the gate doesn't
      // check, and the checklist would keep nagging for something optional.
      const isLast = key === required[required.length - 1];
      expect(isFullyCalibrated(), `after completing "${key}"`).toBe(isLast);
    }

    // …and the reverse direction: the gate is open, so no required stage may
    // still read as outstanding.
    expect(calibrationStageStatus().filter((s) => s.required && !s.complete)).toEqual([]);
  });

  it('counts progress and names the next stage to run', () => {
    expect(requiredCalibrationProgress()).toEqual({ done: 0, total: 4, nextStage: 'main' });
    completeStage('main');
    expect(requiredCalibrationProgress()).toEqual({ done: 1, total: 4, nextStage: 'sidebars' });
    completeStage('sidebars');
    completeStage('gifts');
    completeStage('members');
    expect(requiredCalibrationProgress()).toEqual({ done: 4, total: 4, nextStage: null });
  });

  it('never marks the resource-only stages required', () => {
    // Stages 5 and 6 gate the daily resource capture, never a chest scan. If
    // they became required here, a deployment that has never turned resource
    // capture on would be told its scanner is uncalibrated.
    const optional = calibrationStageStatus().filter((s) => !s.required).map((s) => s.key);
    expect(optional).toEqual(['worldmap', 'capital']);
  });

  it('numbers the stages the way the wizard labels them', () => {
    // The checklist renders "Stage N" from `number`; a mismatch would point the
    // operator at a different button than the one they need.
    expect(calibrationStageStatus().map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
