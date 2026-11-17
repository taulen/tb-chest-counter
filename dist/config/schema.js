"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configSchema = void 0;
const zod_1 = require("zod");
const enums_js_1 = require("../models/enums.js");
const chestPointValuesSchema = zod_1.z.record(zod_1.z.nativeEnum(enums_js_1.ChestType), zod_1.z.number().int().min(0)).default({
    [enums_js_1.ChestType.COMMON]: 1,
    [enums_js_1.ChestType.UNCOMMON]: 2,
    [enums_js_1.ChestType.RARE]: 5,
    [enums_js_1.ChestType.EPIC]: 10,
    [enums_js_1.ChestType.LEGENDARY]: 25,
    [enums_js_1.ChestType.ARENA]: 15,
    [enums_js_1.ChestType.EVENT]: 10,
    [enums_js_1.ChestType.UNKNOWN]: 0,
});
exports.configSchema = zod_1.z.object({
    // gameUrl was historically configurable; it's hardcoded now in
    // src/config/game-url.ts because clan switching happens inside the
    // game's canvas, not via different URLs.
    scanIntervalMs: zod_1.z.coerce.number().int().min(30_000).default(7_200_000),
    dbPath: zod_1.z.string().default('./data/tb-chests.db'),
    storageStatePath: zod_1.z.string().default('./data/auth/storage-state.json'),
    webPort: zod_1.z.coerce.number().int().min(1).max(65535).default(3000),
    webExternalUrl: zod_1.z.string().default(''),
    webEnabled: zod_1.z.preprocess((v) => v === 'true' || v === true || v === undefined, zod_1.z.boolean().default(true)),
    gameDayRolloverUtcHour: zod_1.z.coerce.number().int().min(0).max(23).default(17),
    chestPointValues: zod_1.z.preprocess((v) => typeof v === 'string' ? JSON.parse(v) : v, chestPointValuesSchema),
    logLevel: zod_1.z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});
//# sourceMappingURL=schema.js.map