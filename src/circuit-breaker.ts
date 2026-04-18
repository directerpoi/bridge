// ─── Circuit Breaker Pattern ───────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures before the circuit opens (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting to half-open the circuit (default: 30000) */
  resetTimeout: number;
  /** Number of successful requests in half-open state to close the circuit (default: 1) */
  halfOpenRequests: number;
  /** Optional callback when circuit state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenRequests: 1,
};

/**
 * Circuit breaker for fault tolerance.
 * Prevents cascading failures by short-circuiting requests when a service is unhealthy.
 *
 * States:
 * - **closed**: Normal operation, requests flow through
 * - **open**: Requests are immediately rejected (fast-fail)
 * - **half-open**: Limited requests are allowed through to test if the service has recovered
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER, ...config };
  }

  /**
   * Get the current circuit state.
   */
  getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }

  /**
   * Check if the circuit should transition from open to half-open.
   */
  private checkStateTransition(): void {
    if (
      this.state === 'open' &&
      Date.now() - this.lastFailureTime >= this.config.resetTimeout
    ) {
      this.transition('half-open');
    }
  }

  /**
   * Transition to a new state.
   */
  private transition(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;
    this.state = newState;

    if (newState === 'half-open') {
      this.successCount = 0;
      this.failureCount = 0;
    }

    if (this.config.onStateChange) {
      this.config.onStateChange(oldState, newState);
    }
  }

  /**
   * Check if a request is allowed to proceed.
   * Throws an error if the circuit is open.
   */
  allowRequest(): boolean {
    this.checkStateTransition();

    switch (this.state) {
      case 'closed':
        return true;
      case 'half-open':
        return true;
      case 'open':
        return false;
      default:
        return true;
    }
  }

  /**
   * Record a successful request.
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.config.halfOpenRequests) {
        this.failureCount = 0;
        this.transition('closed');
      }
    } else if (this.state === 'closed') {
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.transition('open');
    } else if (this.state === 'closed' && this.failureCount >= this.config.failureThreshold) {
      this.transition('open');
    }
  }

  /**
   * Reset the circuit breaker to its initial state.
   */
  reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.transition('closed');
  }

  /**
   * Get current failure count.
   */
  getFailureCount(): number {
    return this.failureCount;
  }
}

/**
 * Resolves circuit breaker configuration from user input.
 */
export function resolveCircuitBreakerConfig(
  input: boolean | Partial<CircuitBreakerConfig> | undefined
): CircuitBreakerConfig | null {
  if (!input) return null;
  if (input === true) return { ...DEFAULT_CIRCUIT_BREAKER };
  return { ...DEFAULT_CIRCUIT_BREAKER, ...input };
}
