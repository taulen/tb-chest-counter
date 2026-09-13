"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateMachine = void 0;
const enums_js_1 = require("../models/enums.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('state-machine');
class StateMachine {
    state = enums_js_1.AppState.IDLE;
    errorCount = 0;
    maxConsecutiveErrors = 5;
    getState() {
        return this.state;
    }
    transition(newState) {
        log.debug(`State: ${this.state} -> ${newState}`);
        this.state = newState;
        if (newState === enums_js_1.AppState.ERROR) {
            this.errorCount++;
            if (this.errorCount >= this.maxConsecutiveErrors) {
                log.warn(`${this.errorCount} consecutive errors, entering cooldown`);
                this.state = enums_js_1.AppState.COOLDOWN;
            }
        }
        else if (newState !== enums_js_1.AppState.COOLDOWN) {
            this.errorCount = 0;
        }
    }
    isIdle() {
        return this.state === enums_js_1.AppState.IDLE;
    }
    isError() {
        return this.state === enums_js_1.AppState.ERROR || this.state === enums_js_1.AppState.COOLDOWN;
    }
    getErrorCount() {
        return this.errorCount;
    }
    reset() {
        this.state = enums_js_1.AppState.IDLE;
        this.errorCount = 0;
    }
}
exports.StateMachine = StateMachine;
//# sourceMappingURL=state-machine.js.map