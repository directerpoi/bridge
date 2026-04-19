// ─── DNS Resolution Cache ───────────────────────────────────────────────────────

import * as dns from 'dns';
import * as net from 'net';

export interface DNSCacheConfig {
  /** Time-to-live in milliseconds for cached DNS entries (default: 30000 = 30 seconds) */
  ttl: number;
  /** Maximum number of cached entries (default: 256) */
  maxSize: number;
}

const DEFAULT_DNS_CACHE_CONFIG: DNSCacheConfig = {
  ttl: 30_000,
  maxSize: 256,
};

interface DNSCacheEntry {
  addresses: dns.LookupAddress[];
  expiresAt: number;
}

/**
 * In-memory DNS resolution cache with TTL expiration.
 * Caches DNS lookups to avoid redundant resolution for frequently accessed hosts.
 * Uses LRU eviction when maxSize is reached.
 */
export class DNSCache {
  private cache = new Map<string, DNSCacheEntry>();
  private config: DNSCacheConfig;

  constructor(config?: Partial<DNSCacheConfig>) {
    this.config = { ...DEFAULT_DNS_CACHE_CONFIG, ...config };
  }

  /**
   * Resolve a hostname, using the cache if available.
   * Returns a list of LookupAddress objects.
   */
  lookup(hostname: string): Promise<dns.LookupAddress[]> {
    // If already an IP, return immediately
    if (net.isIP(hostname)) {
      return Promise.resolve([{ address: hostname, family: net.isIPv4(hostname) ? 4 : 6 }]);
    }

    const cached = this.cache.get(hostname);
    if (cached && Date.now() < cached.expiresAt) {
      // LRU refresh
      this.cache.delete(hostname);
      this.cache.set(hostname, cached);
      return Promise.resolve(cached.addresses);
    }

    // Remove expired entry
    if (cached) {
      this.cache.delete(hostname);
    }

    return new Promise((resolve, reject) => {
      dns.lookup(hostname, { all: true }, (err, addresses) => {
        if (err) {
          reject(new Error(`DNS resolution failed for "${hostname}": ${err.message}`));
          return;
        }

        if (!addresses || addresses.length === 0) {
          reject(new Error(`DNS resolution returned no addresses for "${hostname}"`));
          return;
        }

        // Evict if at max size
        if (this.cache.size >= this.config.maxSize) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey !== undefined) {
            this.cache.delete(firstKey);
          }
        }

        const entry: DNSCacheEntry = {
          addresses,
          expiresAt: Date.now() + this.config.ttl,
        };
        this.cache.set(hostname, entry);

        resolve(addresses);
      });
    });
  }

  /**
   * Clear the entire DNS cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached entries (excluding expired).
   */
  get size(): number {
    this.evictExpired();
    return this.cache.size;
  }

  /**
   * Remove expired entries.
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Remove a specific hostname from the cache.
   */
  invalidate(hostname: string): void {
    this.cache.delete(hostname);
  }

  /**
   * Check if a hostname is in the cache and not expired.
   */
  has(hostname: string): boolean {
    const entry = this.cache.get(hostname);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(hostname);
      return false;
    }
    return true;
  }
}

/**
 * Resolves DNS cache configuration from user input.
 */
export function resolveDNSCacheConfig(
  input: boolean | Partial<DNSCacheConfig> | undefined
): DNSCacheConfig | null {
  if (!input) return null;
  if (input === true) return { ...DEFAULT_DNS_CACHE_CONFIG };
  return { ...DEFAULT_DNS_CACHE_CONFIG, ...input };
}
