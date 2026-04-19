// ─── LRU Response Cache ─────────────────────────────────────────────────────────

import { BridgeResponse, Method } from './types';

export interface CacheConfig {
  /** Time-to-live in milliseconds for cached responses (default: 60000 = 1 minute) */
  ttl: number;
  /** Maximum number of cached responses (default: 100) */
  maxSize: number;
  /** HTTP methods to cache (default: ['GET', 'HEAD']) */
  methods?: Method[];
}

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  ttl: 60_000,
  maxSize: 100,
  methods: ['GET', 'HEAD'],
};

interface CacheEntry {
  response: BridgeResponse;
  expiresAt: number;
}

/**
 * LRU response cache with TTL expiration.
 * Caches successful responses by URL + method key.
 * Automatically evicts expired entries and the least-recently-used entry when full.
 */
export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private config: CacheConfig;

  constructor(config?: Partial<CacheConfig>) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  /**
   * Generate a cache key from method and URL.
   */
  static key(method: string, url: string): string {
    return `${method.toUpperCase()}:${url}`;
  }

  /**
   * Check if a method is cacheable according to config.
   */
  isCacheableMethod(method: string): boolean {
    const methods = this.config.methods || DEFAULT_CACHE_CONFIG.methods!;
    return methods.some((m) => m.toUpperCase() === method.toUpperCase());
  }

  /**
   * Get a cached response. Returns undefined if not found or expired.
   * Moves the accessed entry to the end (most recently used).
   */
  get(key: string): BridgeResponse | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (LRU refresh)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.response;
  }

  /**
   * Store a response in the cache.
   */
  set(key: string, response: BridgeResponse): void {
    // Evict expired entries first
    this.evictExpired();

    // If at max size, evict the least recently used (first entry)
    if (this.cache.size >= this.config.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.config.ttl,
    });
  }

  /**
   * Remove expired entries.
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cached responses.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current number of cached entries.
   */
  get size(): number {
    this.evictExpired();
    return this.cache.size;
  }

  /**
   * Check if a key exists in the cache (and is not expired).
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }
}

/**
 * Resolves cache configuration from user input.
 */
export function resolveCacheConfig(
  input: boolean | Partial<CacheConfig> | undefined
): CacheConfig | null {
  if (!input) return null;
  if (input === true) return { ...DEFAULT_CACHE_CONFIG };
  return { ...DEFAULT_CACHE_CONFIG, ...input };
}
