import { BridgeRequestConfig, BridgeError, RetryConfig, Method } from './types';

// ─── Default Retry Config ──────────────────────────────────────────────────────

const DEFAULT_RETRYABLE_METHODS: Method[] = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];
const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  retries: 3,
  delay: 300,
  maxDelay: 10000,
  backoffFactor: 2,
  retryableMethods: DEFAULT_RETRYABLE_METHODS,
  retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
};

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolves the retry configuration from the request config.
 * Returns null if retry is disabled.
 */
export function resolveRetryConfig(config: BridgeRequestConfig): RetryConfig | null {
  if (!config.retry) return null;

  if (config.retry === true) {
    return { ...DEFAULT_RETRY_CONFIG };
  }

  return {
    ...DEFAULT_RETRY_CONFIG,
    ...config.retry,
  };
}

/**
 * Returns true if the request should be retried based on the error and retry config.
 */
export function shouldRetry(
  error: BridgeError,
  retryConfig: RetryConfig,
  attempt: number,
  method: string
): boolean {
  if (attempt >= retryConfig.retries) return false;

  // Custom condition takes precedence
  if (retryConfig.retryCondition) {
    return retryConfig.retryCondition(error);
  }

  // Check if method is retryable
  const upperMethod = method.toUpperCase() as Method;
  if (!retryConfig.retryableMethods.includes(upperMethod)) return false;

  // Network errors are always retryable
  if (!error.response) return true;

  // Check retryable status codes
  return retryConfig.retryableStatuses.includes(error.response.status);
}

/**
 * Calculates the delay for the given retry attempt using exponential backoff with jitter.
 */
export function calculateDelay(retryConfig: RetryConfig, attempt: number): number {
  const exponentialDelay = retryConfig.delay * Math.pow(retryConfig.backoffFactor, attempt);
  const clampedDelay = Math.min(exponentialDelay, retryConfig.maxDelay);
  // Add jitter: 0.5x to 1.5x of the calculated delay
  const jitter = 0.5 + Math.random();
  return Math.round(clampedDelay * jitter);
}

/**
 * Sleeps for the given number of milliseconds. Supports AbortSignal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request aborted'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Request aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
