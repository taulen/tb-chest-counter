"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = void 0;
const enums_js_1 = require("../models/enums.js");
exports.DEFAULT_CONFIG = {
    scanIntervalMs: 7_200_000, // 120 minutes
    dbPath: './data/tb-chests.db',
    storageStatePath: './data/auth/storage-state.json',
    webPort: 3000,
    webEnabled: true,
    webExternalUrl: '',
    gameDayRolloverUtcHour: 17, // Game's fixed global day boundary (17:00 UTC)
    memberInactivityDays: 7, // Soft-remove members unseen for this many days (0 = disabled)
    chestPointValues: {
        [enums_js_1.ChestType.COMMON]: 1,
        [enums_js_1.ChestType.UNCOMMON]: 2,
        [enums_js_1.ChestType.RARE]: 5,
        [enums_js_1.ChestType.EPIC]: 10,
        [enums_js_1.ChestType.LEGENDARY]: 25,
        [enums_js_1.ChestType.ARENA]: 15,
        [enums_js_1.ChestType.EVENT]: 10,
        [enums_js_1.ChestType.UNKNOWN]: 0,
    },
    logLevel: 'info',
};
//# sourceMappingURL=defaults.js.map