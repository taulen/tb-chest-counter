import type { AppConfig, UIElementLocation, GiftEntry } from '../models/types.js';
import { ScreenState } from '../models/enums.js';

export interface VisionProvider {
  /** Display name of the provider */
  name: string;

  /** Whether this provider needs an API key */
  requiresApiKey: boolean;

  /** Whether this provider can analyze images directly (vs needing OCR pre-processing) */
  supportsImages: boolean;

  /** Initialize the provider with app config */
  initialize(config: AppConfig): Promise<void>;

  /**
   * Release any resources held by the provider (worker threads, native/model
   * memory). The provider must be safely re-`initialize()`-able after teardown
   * — the scan loop periodically tears down + recreates the browser and
   * provider to reclaim native memory (see ScanLoop.performPeriodicRelaunch).
   * Optional because providers without long-lived workers (the ONNX-backed
   * PaddleOCR service) have nothing to release, so it's a no-op there.
   */
  teardown?(): Promise<void>;

  /** Detect what screen/state the game is showing */
  detectScreenState(screenshot: Buffer): Promise<ScreenState>;

  /** Find a UI element's pixel coordinates in a screenshot */
  findUIElement(screenshot: Buffer, description: string): Promise<UIElementLocation | null>;

  /**
   * If detectScreenState() most recently returned MAINTENANCE and the provider
   * was able to parse a duration from the maintenance message, return the
   * remaining time in milliseconds. Returns null otherwise.
   */
  getLastMaintenanceDurationMs?(): number | null;

  /**
   * Optionally supply the active clan roster before a scan. Providers that do
   * a non-Latin recovery pass (PaddleOCR) use it to skip that pass for names
   * that already resolve to a known member, and to pre-warm their language
   * models so recovery doesn't stall mid-scan. No-op for providers that don't
   * implement it.
   */
  setScanContext?(knownMembers: string[]): void;

  /**
   * Extract gift data from a single-card crop. Used by the pipelined
   * scanner which captures the topmost gift card region only and then
   * OCRs it to insert exactly one row per click.
   *
   * Returns the parsed entry or null if the crop doesn't contain a
   * recognizable gift card (empty list, popup overlay, OCR failure).
   * Optional because only local card-OCR providers need it; the
   * pipelined scanner refuses to run if the active provider doesn't
   * implement it.
   */
  extractTopCardFromCrop?(cropBuffer: Buffer): Promise<GiftEntry | null>;

  /**
   * Extract ALL gift cards from a crop that covers multiple visible
   * cards. Used by the pipelined scanner in batch mode — the crop
   * covers all ~4 visible cards in the gift panel.
   *
   * Returns the parsed entries plus the raw OCR text. The text is
   * needed by the capture loop to short-circuit the full-page
   * screen-state OCR when it explicitly contains "no gifts" — the
   * card crop already told us the list is empty, so the safety
   * re-confirmation can be skipped on that path.
   */
  extractCardsFromCrop?(cropBuffer: Buffer): Promise<{ entries: GiftEntry[]; rawText: string }>;
}
