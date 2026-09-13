import { describe, expect, it } from 'vitest';
import {
  parseScreenStateResponse,
  parseUIElementResponse,
} from '../../src/vision/parser.js';
import { ScreenState } from '../../src/models/enums.js';

/**
 * Vision-LLM response parsing. Pure functions — feed them response text
 * the way Anthropic / OpenAI / Gemini emit it, assert the parsed shape.
 *
 * Together with chest-names.test.ts, these form the deterministic-data
 * safety net for Phase C2: when ScanLoop is decomposed, the parser
 * must keep producing identical `ScreenState` / `(x,y)` outputs given
 * identical inputs.
 */

describe('parseScreenStateResponse', () => {
  it('parses a clean JSON response', () => {
    const text = JSON.stringify({ screenState: 'gift_tab' });
    expect(parseScreenStateResponse(text)).toBe(ScreenState.GIFT_TAB);
  });

  it('strips ```json fences', () => {
    const text = '```json\n{"screenState": "main_game"}\n```';
    expect(parseScreenStateResponse(text)).toBe(ScreenState.MAIN_GAME);
  });

  it('strips bare ``` fences', () => {
    const text = '```\n{"screenState": "loading"}\n```';
    expect(parseScreenStateResponse(text)).toBe(ScreenState.LOADING);
  });

  it('coerces an unknown screenState string to UNKNOWN (zod .catch)', () => {
    const text = JSON.stringify({ screenState: 'mystery_screen' });
    expect(parseScreenStateResponse(text)).toBe(ScreenState.UNKNOWN);
  });

  it('returns UNKNOWN on malformed JSON', () => {
    expect(parseScreenStateResponse('not json at all')).toBe(ScreenState.UNKNOWN);
    expect(parseScreenStateResponse('')).toBe(ScreenState.UNKNOWN);
  });

  it('returns UNKNOWN when the screenState field is missing', () => {
    expect(parseScreenStateResponse('{}')).toBe(ScreenState.UNKNOWN);
  });
});

describe('parseUIElementResponse', () => {
  it('returns coordinates when found=true', () => {
    const text = JSON.stringify({ found: true, x: 100, y: 200 });
    expect(parseUIElementResponse(text)).toEqual({ x: 100, y: 200 });
  });

  it('returns null when found=false', () => {
    const text = JSON.stringify({ found: false, x: 0, y: 0 });
    expect(parseUIElementResponse(text)).toBeNull();
  });

  it('handles ```json fenced responses', () => {
    const text = '```json\n{"found": true, "x": 50, "y": 75}\n```';
    expect(parseUIElementResponse(text)).toEqual({ x: 50, y: 75 });
  });

  it('returns null on malformed JSON', () => {
    expect(parseUIElementResponse('garbage')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseUIElementResponse('{"found": true}')).toBeNull();
  });

  it('returns null when found is not a boolean', () => {
    const text = JSON.stringify({ found: 'yes', x: 1, y: 2 });
    expect(parseUIElementResponse(text)).toBeNull();
  });
});
