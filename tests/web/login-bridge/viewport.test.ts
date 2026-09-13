import { describe, expect, it } from 'vitest';
import { resolveBridgeDisplay, resolveBridgeViewport } from '../../../src/web/login-bridge.js';

/**
 * Render resolution is the lever that raises the game's own framerate when
 * WebGL is on the CPU. Screencast quality/framerate tuning can't substitute:
 * it only affects frames the browser already drew. So this parse has to be
 * forgiving of input but strict about producing something sane.
 */
describe('resolveBridgeViewport', () => {
  it('defaults to 1280x800 for missing or unparseable input', () => {
    expect(resolveBridgeViewport(undefined)).toEqual({ width: 1280, height: 800 });
    expect(resolveBridgeViewport('')).toEqual({ width: 1280, height: 800 });
    expect(resolveBridgeViewport('  ')).toEqual({ width: 1280, height: 800 });
    expect(resolveBridgeViewport('nonsense')).toEqual({ width: 1280, height: 800 });
    expect(resolveBridgeViewport('1280')).toEqual({ width: 1280, height: 800 });
    expect(resolveBridgeViewport('1280x')).toEqual({ width: 1280, height: 800 });
  });

  it('parses the documented form', () => {
    expect(resolveBridgeViewport('960x600')).toEqual({ width: 960, height: 600 });
  });

  it('tolerates whitespace, capitals and an asterisk separator', () => {
    expect(resolveBridgeViewport(' 960 X 600 ')).toEqual({ width: 960, height: 600 });
    expect(resolveBridgeViewport('960*600')).toEqual({ width: 960, height: 600 });
  });

  it('clamps values too small to read a login form in', () => {
    expect(resolveBridgeViewport('320x240')).toEqual({ width: 640, height: 480 });
  });

  it('clamps values large enough to defeat the purpose', () => {
    expect(resolveBridgeViewport('3840x2160')).toEqual({ width: 1920, height: 1200 });
  });

  it('always returns a usable pair, never NaN', () => {
    for (const input of [undefined, '', 'x', '0x0', '9999x9999', 'axb']) {
      const v = resolveBridgeViewport(input);
      expect(Number.isInteger(v.width)).toBe(true);
      expect(Number.isInteger(v.height)).toBe(true);
      expect(v.width).toBeGreaterThan(0);
      expect(v.height).toBeGreaterThan(0);
    }
  });
});

/**
 * The bridge defaults to Chromium's NEW headless mode. That is not a
 * downgrade of the interactive session: it's a full browser rendering
 * offscreen, so screencast, input injection and the persistent profile all
 * behave as before — and it's the only mode that can use the iGPU, since Xvfb
 * is a pure software framebuffer.
 */
describe('resolveBridgeDisplay', () => {
  it('defaults to new headless', () => {
    expect(resolveBridgeDisplay(undefined)).toBe('headless');
    expect(resolveBridgeDisplay('')).toBe('headless');
    expect(resolveBridgeDisplay('headless')).toBe('headless');
  });

  it('honours the xvfb escape hatch', () => {
    expect(resolveBridgeDisplay('xvfb')).toBe('xvfb');
    expect(resolveBridgeDisplay('  XVFB  ')).toBe('xvfb');
    // 'headed' is the same request said differently.
    expect(resolveBridgeDisplay('headed')).toBe('xvfb');
  });

  it('falls back to headless for anything unrecognised', () => {
    expect(resolveBridgeDisplay('wayland')).toBe('headless');
    expect(resolveBridgeDisplay('nonsense')).toBe('headless');
  });
});
