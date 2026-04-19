// ─── Request Concurrency Control ───────────────────────────────────────────────

export interface ConcurrencyConfig {
  /** Maximum number of concurrent requests (default: 10) */
  maxConcurrent: number;
  /** Maximum time in ms a request can wait in the concurrency queue before being rejected (default: 0 = no limit).
   *  Prevents indefinite queuing in worst-case overload scenarios. */
  queueTimeout?: number;
}

const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  maxConcurrent: 10,
};

interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  priority: number;
  enqueuedAt: number;
  timerHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Controls the maximum number of concurrent requests.
 * Queues excess requests and processes them in priority order (higher priority first, FIFO within same priority).
 * Supports queue timeout to prevent indefinite waiting in worst-case scenarios.
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
   * @param fn - The async function to execute
   * @param priority - Priority for queue ordering (higher = processed first, default: 0)
   */
  execute<T>(fn: () => Promise<T>, priority: number = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queuedRequest: QueuedRequest<unknown> = {
        execute: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        priority,
        enqueuedAt: Date.now(),
      };

      if (this.running < this.config.maxConcurrent) {
        this.runRequest(queuedRequest);
      } else {
        // Set up queue timeout if configured
        if (this.config.queueTimeout && this.config.queueTimeout > 0) {
          queuedRequest.timerHandle = setTimeout(() => {
            // Remove from queue
            const idx = this.queue.indexOf(queuedRequest);
            if (idx !== -1) {
              this.queue.splice(idx, 1);
              queuedRequest.reject(
                new Error(
                  `Request exceeded queue timeout of ${this.config.queueTimeout}ms. ` +
                  `Queue depth: ${this.queue.length}, running: ${this.running}/${this.config.maxConcurrent}`
                )
              );
            }
          }, this.config.queueTimeout);
        }

        // Insert in priority order (higher priority first, FIFO within same priority)
        this.insertByPriority(queuedRequest);
      }
    });
  }

  private insertByPriority(request: QueuedRequest<unknown>): void {
    // Find the position to insert: after all items with equal or higher priority
    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < request.priority) {
        insertIdx = i;
        break;
      }
    }
    this.queue.splice(insertIdx, 0, request);
  }

  private async runRequest(request: QueuedRequest<unknown>): Promise<void> {
    // Clear queue timeout timer if it was set
    if (request.timerHandle) {
      clearTimeout(request.timerHandle);
      request.timerHandle = undefined;
    }
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
