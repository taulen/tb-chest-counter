// Shared scan-cycle result type, broken out of loop.ts so the scan
// finalize/failure helpers in scan-finalize.ts can reference it
// without taking a circular import on the ScanLoop class.

import type { GiftEntry } from '../models/types.js';

export interface ScanResult {
  success: boolean;
  /** DB session id for this scan. Set once the row exists; absent for
   *  results returned before a session was created (e.g. auth failure). */
  sessionId?: number;
  chestsFound: number;
  newChests: number;
  errors: number;
  giftsData: GiftEntry[];
  /** Triumphal-tab gifts from this scan (0-point bookkeeping rows).
   *  Printed as a separate section in the scan report. */
  triumphalData: GiftEntry[];
  alreadyRunning?: boolean;
}
