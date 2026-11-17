"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.avatarFrameImageFrom = exports.heroAvatarImageFrom = exports.matchTroopIcons = exports.ART_PATTERNS = exports.ART_CATEGORIES = exports.createGameArtRouter = exports.gameArtDir = exports.avatarFrameImage = exports.heroAvatarImage = exports.gameArtUrl = exports.currentGameArt = exports.stopGameArtSchedule = exports.startGameArtSchedule = exports.ensureGameArt = void 0;
/**
 * Total Battle game art, extracted from the game's own Unity asset bundles in
 * pure Node and served per game version. Public API; see store.ts for the
 * pipeline and selection.ts for what is extracted.
 */
var store_js_1 = require("./store.js");
Object.defineProperty(exports, "ensureGameArt", { enumerable: true, get: function () { return store_js_1.ensureGameArt; } });
Object.defineProperty(exports, "startGameArtSchedule", { enumerable: true, get: function () { return store_js_1.startGameArtSchedule; } });
Object.defineProperty(exports, "stopGameArtSchedule", { enumerable: true, get: function () { return store_js_1.stopGameArtSchedule; } });
Object.defineProperty(exports, "currentGameArt", { enumerable: true, get: function () { return store_js_1.currentGameArt; } });
Object.defineProperty(exports, "gameArtUrl", { enumerable: true, get: function () { return store_js_1.gameArtUrl; } });
Object.defineProperty(exports, "heroAvatarImage", { enumerable: true, get: function () { return store_js_1.heroAvatarImage; } });
Object.defineProperty(exports, "avatarFrameImage", { enumerable: true, get: function () { return store_js_1.avatarFrameImage; } });
Object.defineProperty(exports, "gameArtDir", { enumerable: true, get: function () { return store_js_1.gameArtDir; } });
var routes_js_1 = require("./routes.js");
Object.defineProperty(exports, "createGameArtRouter", { enumerable: true, get: function () { return routes_js_1.createGameArtRouter; } });
var selection_js_1 = require("./selection.js");
Object.defineProperty(exports, "ART_CATEGORIES", { enumerable: true, get: function () { return selection_js_1.ART_CATEGORIES; } });
Object.defineProperty(exports, "ART_PATTERNS", { enumerable: true, get: function () { return selection_js_1.ART_PATTERNS; } });
var mappings_js_1 = require("./mappings.js");
Object.defineProperty(exports, "matchTroopIcons", { enumerable: true, get: function () { return mappings_js_1.matchTroopIcons; } });
Object.defineProperty(exports, "heroAvatarImageFrom", { enumerable: true, get: function () { return mappings_js_1.heroAvatarImageFrom; } });
Object.defineProperty(exports, "avatarFrameImageFrom", { enumerable: true, get: function () { return mappings_js_1.avatarFrameImageFrom; } });
//# sourceMappingURL=index.js.map