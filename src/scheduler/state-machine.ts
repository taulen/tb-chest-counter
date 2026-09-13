import { AppState } from '../models/enums.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('state-machine');

export class StateMachine {
  private state: AppState = AppState.IDLE;
  private errorCount = 0;
  private maxConsecutiveErrors = 5;

  getState(): AppState {
    return this.state;
  }

  transition(newState: AppState): void {
    log.debug(`State: ${this.state} -> ${newState}`);
    this.state = newState;

    if (newState === AppState.ERROR) {
      this.errorCount++;
      if (this.errorCount >= this.maxConsecutiveErrors) {
        log.warn(`${this.errorCount} consecutive errors, entering cooldown`);
        this.state = AppState.COOLDOWN;
      }
    } else if (newState !== AppState.COOLDOWN) {
      this.errorCount = 0;
    }
  }

  isIdle(): boolean {
    return this.state === AppState.IDLE;
  }

  isError(): boolean {
    return this.state === AppState.ERROR || this.state === AppState.COOLDOWN;
  }

  getErrorCount(): number {
    return this.errorCount;
  }

  reset(): void {
    this.state = AppState.IDLE;
    this.errorCount = 0;
  }
}
