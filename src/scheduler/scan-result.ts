// Shared scan-cycle result type, broken out of loop.ts so the scan
// finalize/failure helpers in scan-finalize.ts can reference it
// without taking a circular import on the ScanLoop class.

import type { VisionExtractionResult } from '../models/types.js';

export interface ScanResult {
  success: boolean;
  /** DB session id for this scan. Set once the row exists; absent for
   *  results returned before a session was created (e.g. auth failure). */
  sessionId?: number;
  chestsFound: number;
  newChests: number;
  errors: number;
  giftsData: VisionExtractionResult['gifts'];
  /** Triumphal-tab cards from this scan (0-point bookkeeping rows).
   *  Empty when the triumphal tab isn't calibrated or the sweep was
   *  skipped/failed. Printed as a separate section in the scan report. */
  triumphalData: VisionExtractionResult['gifts'];
  alreadyRunning?: boolean;
}
