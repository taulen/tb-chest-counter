import { z } from 'zod';
import { ScreenState } from '../models/enums.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('parser');

const screenStateResponseSchema = z.object({
  screenState: z.nativeEnum(ScreenState).catch(ScreenState.UNKNOWN),
  description: z.string().optional(),
});

const uiElementResponseSchema = z.object({
  found: z.boolean(),
  x: z.number(),
  y: z.number(),
  description: z.string().optional(),
});

function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();

  // Remove markdown code blocks
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

export function parseScreenStateResponse(rawResponse: string): ScreenState {
  try {
    const cleaned = cleanJsonResponse(rawResponse);
    const parsed = JSON.parse(cleaned);
    const validated = screenStateResponseSchema.parse(parsed);
    return validated.screenState;
  } catch {
    log.error('Failed to parse screen state response');
    return ScreenState.UNKNOWN;
  }
}

export function parseUIElementResponse(rawResponse: string): { x: number; y: number } | null {
  try {
    const cleaned = cleanJsonResponse(rawResponse);
    const parsed = JSON.parse(cleaned);
    const validated = uiElementResponseSchema.parse(parsed);
    return validated.found ? { x: validated.x, y: validated.y } : null;
  } catch {
    log.error('Failed to parse UI element response');
    return null;
  }
}
