// ─── Rate Limiter (Token Bucket Algorithm) ─────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the time window (default: 10) */
  maxRequests: number;
  /** Time window in milliseconds (default: 1000 = 1 second) */
  windowMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowMs: 1000,
};

/**
 * Token bucket rate limiter.
 * Controls request throughput by limiting the number of requests within a sliding window.
 */
export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private windowMs: number;
  private lastRefill: number;

  constructor(config?: Partial<RateLimitConfig>) {
    const resolved = { ...DEFAULT_RATE_LIMIT, ...config };
    this.maxTokens = resolved.maxRequests;
    this.windowMs = resolved.windowMs;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / this.windowMs) * this.maxTokens;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Attempt to acquire a token. Returns true if allowed, false if rate limited.
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Wait until a token is available, then acquire it.
   * Supports AbortSignal for cancellation.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Rate limit wait aborted'));
        return;
      }

      if (this.tryAcquire()) {
        resolve();
        return;
      }

      // Calculate wait time until next token
      const waitMs = Math.ceil(this.windowMs / this.maxTokens);

      const timer = setTimeout(() => {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          resolve();
        } else {
          // Recursive retry
          this.acquire(signal).then(resolve, reject);
        }
      }, waitMs);

      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Rate limit wait aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Get current number of available tokens.
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Reset the rate limiter to full capacity.
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}

/**
 * Resolves rate limit configuration from user input.
 */
export function resolveRateLimitConfig(
  input: boolean | Partial<RateLimitConfig> | undefined
): RateLimitConfig | null {
  if (!input) return null;
  if (input === true) return { ...DEFAULT_RATE_LIMIT };
  return { ...DEFAULT_RATE_LIMIT, ...input };
}
