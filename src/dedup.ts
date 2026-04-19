// ─── Request Deduplication ──────────────────────────────────────────────────────

import { BridgeResponse } from './types';

/**
 * Deduplicates concurrent identical requests.
 * If a request with the same key (method + URL) is already in-flight,
 * returns the same promise instead of issuing a new request.
 * This prevents redundant network calls for duplicate concurrent requests.
 */
export class RequestDeduplicator {
  private inflight = new Map<string, Promise<BridgeResponse>>();

  /**
   * Generate a deduplication key from method and URL.
   */
  static key(method: string, url: string): string {
    return `${method.toUpperCase()}:${url}`;
  }

  /**
   * Execute a request with deduplication.
   * If a matching request is already in-flight, returns the same promise.
   * Otherwise, executes the factory function and tracks the promise.
   */
  execute(
    key: string,
    factory: () => Promise<BridgeResponse>
  ): Promise<BridgeResponse> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = factory().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Get the number of currently in-flight deduplicated requests.
   */
  getInflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Check if a request with the given key is currently in-flight.
   */
  isInflight(key: string): boolean {
    return this.inflight.has(key);
  }
}
