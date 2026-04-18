// ─── Request Concurrency Control ───────────────────────────────────────────────

export interface ConcurrencyConfig {
  /** Maximum number of concurrent requests (default: 10) */
  maxConcurrent: number;
}

const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  maxConcurrent: 10,
};

interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Controls the maximum number of concurrent requests.
 * Queues excess requests and processes them in FIFO order.
 */
export class ConcurrencyManager {
  private running = 0;
  private queue: Array<QueuedRequest<unknown>> = [];
  private config: ConcurrencyConfig;

  constructor(config?: Partial<ConcurrencyConfig>) {
    this.config = { ...DEFAULT_CONCURRENCY, ...config };
  }

  /**
   * Execute a function with concurrency control.
   * If max concurrent is reached, the request is queued.
   */
  execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queuedRequest: QueuedRequest<unknown> = {
        execute: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      if (this.running < this.config.maxConcurrent) {
        this.runRequest(queuedRequest);
      } else {
        this.queue.push(queuedRequest);
      }
    });
  }

  private async runRequest(request: QueuedRequest<unknown>): Promise<void> {
    this.running++;
    try {
      const result = await request.execute();
      request.resolve(result);
    } catch (err) {
      request.reject(err);
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.queue.length > 0 && this.running < this.config.maxConcurrent) {
      const next = this.queue.shift()!;
      this.runRequest(next);
    }
  }

  /**
   * Get the number of currently running requests.
   */
  getRunning(): number {
    return this.running;
  }

  /**
   * Get the number of queued requests.
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get the maximum concurrent requests allowed.
   */
  getMaxConcurrent(): number {
    return this.config.maxConcurrent;
  }
}

/**
 * Resolves concurrency configuration from user input.
 */
export function resolveConcurrencyConfig(
  input: number | Partial<ConcurrencyConfig> | undefined
): ConcurrencyConfig | null {
  if (input === undefined) return null;
  if (typeof input === 'number') return { maxConcurrent: input };
  return { ...DEFAULT_CONCURRENCY, ...input };
}
