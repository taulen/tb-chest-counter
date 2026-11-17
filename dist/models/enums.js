"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppState = exports.ScanStatus = exports.ChestSource = exports.ChestType = void 0;
var ChestType;
(function (ChestType) {
    ChestType["COMMON"] = "common";
    ChestType["UNCOMMON"] = "uncommon";
    ChestType["RARE"] = "rare";
    ChestType["EPIC"] = "epic";
    ChestType["LEGENDARY"] = "legendary";
    ChestType["ARENA"] = "arena";
    ChestType["EVENT"] = "event";
    ChestType["UNKNOWN"] = "unknown";
})(ChestType || (exports.ChestType = ChestType = {}));
var ChestSource;
(function (ChestSource) {
    ChestSource["CLAN_GIFT"] = "clan_gift";
    ChestSource["MONSTER_KILL"] = "monster_kill";
    ChestSource["ARENA"] = "arena";
    ChestSource["EVENT"] = "event";
    ChestSource["UNKNOWN"] = "unknown";
})(ChestSource || (exports.ChestSource = ChestSource = {}));
var ScanStatus;
(function (ScanStatus) {
    ScanStatus["PENDING"] = "pending";
    ScanStatus["PROCESSING"] = "processing";
    ScanStatus["COMPLETED"] = "completed";
    ScanStatus["FAILED"] = "failed";
})(ScanStatus || (exports.ScanStatus = ScanStatus = {}));
var AppState;
(function (AppState) {
    AppState["IDLE"] = "idle";
    AppState["SCANNING"] = "scanning";
    AppState["PROCESSING"] = "processing";
    AppState["EXPORTING"] = "exporting";
    AppState["ERROR"] = "error";
    AppState["COOLDOWN"] = "cooldown";
})(AppState || (exports.AppState = AppState = {}));
//# sourceMappingURL=enums.js.map