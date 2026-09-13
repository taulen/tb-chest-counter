"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseScreenStateResponse = parseScreenStateResponse;
exports.parseUIElementResponse = parseUIElementResponse;
const zod_1 = require("zod");
const enums_js_1 = require("../models/enums.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('parser');
const screenStateResponseSchema = zod_1.z.object({
    screenState: zod_1.z.nativeEnum(enums_js_1.ScreenState).catch(enums_js_1.ScreenState.UNKNOWN),
    description: zod_1.z.string().optional(),
});
const uiElementResponseSchema = zod_1.z.object({
    found: zod_1.z.boolean(),
    x: zod_1.z.number(),
    y: zod_1.z.number(),
    description: zod_1.z.string().optional(),
});
function cleanJsonResponse(text) {
    let cleaned = text.trim();
    // Remove markdown code blocks
    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.slice(7);
    }
    else if (cleaned.startsWith('```')) {
        cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3);
    }
    return cleaned.trim();
}
function parseScreenStateResponse(rawResponse) {
    try {
        const cleaned = cleanJsonResponse(rawResponse);
        const parsed = JSON.parse(cleaned);
        const validated = screenStateResponseSchema.parse(parsed);
        return validated.screenState;
    }
    catch {
        log.error('Failed to parse screen state response');
        return enums_js_1.ScreenState.UNKNOWN;
    }
}
function parseUIElementResponse(rawResponse) {
    try {
        const cleaned = cleanJsonResponse(rawResponse);
        const parsed = JSON.parse(cleaned);
        const validated = uiElementResponseSchema.parse(parsed);
        return validated.found ? { x: validated.x, y: validated.y } : null;
    }
    catch {
        log.error('Failed to parse UI element response');
        return null;
    }
}
//# sourceMappingURL=parser.js.map