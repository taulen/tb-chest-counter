import type { Page } from 'playwright';
import { mouseClick, mouseMove } from '../browser/input.js';

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Length of the final, human-like leg of a pointer move, in CSS px.
 *
 * Deliberately shorter than anything we click. Every intermediate step is a
 * real hover as far as the page is concerned, so a leg longer than the target
 * would start outside it and sweep in across whatever sits next door.
 */
const APPROACH_PX = 6;

export async function humanMouseMove(page: Page, x: number, y: number): Promise<void> {
  // Jump to just off the target, then cover the last few pixels in steps.
  //
  // This used to interpolate 5-15 steps all the way from wherever the cursor
  // happened to be. Over a game canvas that straight line is not inert:
  // Playwright dispatches a real mousemove at every step, so the engine sees
  // the pointer hover every object the line crosses. ensureOnGiftsTab draws
  // that line across the middle of the city twice per attempt — CLAN sits
  // bottom-centre and the Gifts rail mid-left, so the segment between them
  // runs right over the player's own keep. Anything the game puts there
  // (an attack marker, a march, a quest pin) gets hovered ~50-200ms before
  // the click lands, and a hover that opens a tooltip or a map panel can
  // absorb that click. The screenshot taken seconds later shows nothing,
  // because by then the cursor has moved on.
  //
  // Nothing needed the long path. It arrived in the initial commit as generic
  // "look human" boilerplate with no anti-bot requirement behind it, and a
  // perfectly straight interpolation was never convincing as one anyway.
  const angle = Math.random() * Math.PI * 2;
  await mouseMove(
    page,
    x + Math.cos(angle) * APPROACH_PX,
    y + Math.sin(angle) * APPROACH_PX,
    { steps: 1 },
  );
  const steps = 5 + Math.floor(Math.random() * 10);
  await mouseMove(page, x, y, { steps });
}

export async function humanClick(page: Page, x: number, y: number): Promise<void> {
  // Add slight random offset to avoid pixel-perfect clicking
  const offsetX = x + (Math.random() - 0.5) * 4;
  const offsetY = y + (Math.random() - 0.5) * 4;

  await humanMouseMove(page, offsetX, offsetY);
  await randomDelay(50, 200);
  await mouseClick(page, offsetX, offsetY);
  await randomDelay(200, 500);
}

