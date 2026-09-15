"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppState = exports.ScreenState = exports.ScanStatus = exports.ChestSource = exports.ChestType = void 0;
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
var ScreenState;
(function (ScreenState) {
    ScreenState["GIFT_TAB"] = "gift_tab";
    ScreenState["NO_GIFTS"] = "no_gifts";
    ScreenState["LOGIN_REQUIRED"] = "login_required";
    ScreenState["LOADING"] = "loading";
    ScreenState["MAIN_GAME"] = "main_game";
    ScreenState["POPUP"] = "popup";
    ScreenState["MAINTENANCE"] = "maintenance";
    /** The game's "Connection lost" dialog: the account was signed in elsewhere. */
    ScreenState["SESSION_KICKED"] = "session_kicked";
    ScreenState["UNKNOWN"] = "unknown";
})(ScreenState || (exports.ScreenState = ScreenState = {}));
var AppState;
(function (AppState) {
    AppState["IDLE"] = "idle";
    AppState["CHECKING_AUTH"] = "checking_auth";
    AppState["NAVIGATING"] = "navigating";
    AppState["SCANNING"] = "scanning";
    AppState["PROCESSING"] = "processing";
    AppState["EXPORTING"] = "exporting";
    AppState["ERROR"] = "error";
    AppState["COOLDOWN"] = "cooldown";
})(AppState || (exports.AppState = AppState = {}));
//# sourceMappingURL=enums.js.map