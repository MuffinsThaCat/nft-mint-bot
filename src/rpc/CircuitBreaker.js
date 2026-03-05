import { CIRCUIT_BREAKER } from '../config/constants.js';

const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

export class CircuitBreaker {
  constructor(name) {
    this.name = name;
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.lastFailureTime = null;
    this.nextTestTime = null;
  }

  async execute(fn) {
    if (this.state === STATE.OPEN) {
      if (Date.now() >= this.nextTestTime) {
        this.state = STATE.HALF_OPEN;
        // Reset consecutive failures when entering HALF_OPEN for fair test
        this.consecutiveFailures = 0;
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    if (this.state === STATE.HALF_OPEN) {
      this.state = STATE.CLOSED;
    }
    this.consecutiveFailures = 0;
    this.lastFailureTime = null;
  }

  onFailure() {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= CIRCUIT_BREAKER.FAILURE_THRESHOLD) {
      this.state = STATE.OPEN;
      this.nextTestTime = Date.now() + CIRCUIT_BREAKER.HALF_OPEN_TEST_DELAY_MS;
    }
  }

  reset() {
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.lastFailureTime = null;
    this.nextTestTime = null;
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime
    };
  }

  isAvailable() {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.HALF_OPEN) return true;
    if (this.state === STATE.OPEN && Date.now() >= this.nextTestTime) {
      return true;
    }
    return false;
  }

  serialize() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
      nextTestTime: this.nextTestTime
    };
  }

  static deserialize(data) {
    const breaker = new CircuitBreaker(data.name);
    
    // Validate state is one of the allowed values
    if (data.state && Object.values(STATE).includes(data.state)) {
      breaker.state = data.state;
    } else {
      breaker.state = STATE.CLOSED;
    }
    
    breaker.consecutiveFailures = data.consecutiveFailures || 0;
    breaker.lastFailureTime = data.lastFailureTime || null;
    breaker.nextTestTime = data.nextTestTime || null;
    return breaker;
  }
}
