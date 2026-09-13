"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultIconPath = defaultIconPath;
exports.loadIconTemplate = loadIconTemplate;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const resource_repo_js_1 = require("../data/repositories/resource-repo.js");
/** Path to a shipped default icon PNG, named by resource slug. */
function defaultIconPath(slug) {
    // __dirname is dist/utils/ at runtime, so ../.. reaches the repo root.
    return path_1.default.resolve(__dirname, '..', '..', 'assets', 'resource-icons', `${slug}.png`);
}
/**
 * Load the reference icon template for a given resource type.
 * Resolution order:
 *   1. Per-clan override stored in DB as a BLOB.
 *   2. Shipped default PNG from data/resource-icons/<slug>.png.
 *   3. null — type not yet calibrated.
 */
async function loadIconTemplate(clanId, resourceTypeId, slug) {
    const dbBlob = (0, resource_repo_js_1.getIconTemplate)(clanId, resourceTypeId);
    if (dbBlob)
        return dbBlob;
    const filePath = defaultIconPath(slug);
    try {
        return fs_1.default.readFileSync(filePath);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=resource-icons.js.map