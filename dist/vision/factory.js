"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVisionProvider = createVisionProvider;
const paddle_provider_js_1 = require("./paddle-provider.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('vision-factory');
function createVisionProvider() {
    log.info('Vision engine: PaddleOCR (PP-OCRv6_small, ONNX)');
    return new paddle_provider_js_1.PaddleOcrProvider();
}
//# sourceMappingURL=factory.js.map