import { BridgeRequestConfig, BridgeResponse, BridgeInstance, InterceptorHandler, RateLimitConfig, CircuitBreakerConfig, ConcurrencyConfig } from './types';
import { InterceptorManager } from './interceptors';
import { httpAdapter } from './adapter';
import { mergeConfig, buildFullURL } from './utils';
import { RateLimiter, resolveRateLimitConfig } from './ratelimit';
import { CircuitBreaker, resolveCircuitBreakerConfig, CircuitState } from './circuit-breaker';
import { ConcurrencyManager, resolveConcurrencyConfig } from './concurrency';
import { ResponseCache, resolveCacheConfig, CacheConfig } from './cache';
import { RequestDeduplicator } from './dedup';
import { createError } from './error';
import { DNSCache, resolveDNSCacheConfig, DNSCacheConfig } from './dns-cache';
import { CookieJar, resolveCookieJarConfig, CookieJarConfig } from './cookie';
import { MiddlewarePipeline, MiddlewareFunction, MiddlewareContext } from './middleware';
import { HTTP2SessionManager, resolveHTTP2Config } from './http2';

/**
 * The Bridge HTTP client class.
 * API-compatible with axios — supports interceptors, defaults, and convenience methods.
 * v4.0.0: Adds rate limiting, circuit breaker, concurrency control, progress events, timeline, and hooks.
 * v7.0.0: Adds HTTP/2, proxy, cookie jar, DNS caching, and middleware pipeline.
 */
export class Bridge {
  defaults: BridgeRequestConfig;
  interceptors: {
    request: InterceptorManager<BridgeRequestConfig>;
    response: InterceptorManager<BridgeResponse>;
  };

  private rateLimiter: RateLimiter | null = null;
  private circuitBreaker: CircuitBreaker | null = null;
  private concurrencyManager: ConcurrencyManager | null = null;
  private responseCache: ResponseCache | null = null;
  private deduplicator: RequestDeduplicator | null = null;
  private dnsCache: DNSCache | null = null;
  private cookieJar: CookieJar | null = null;
  private middlewarePipeline: MiddlewarePipeline = new MiddlewarePipeline();
  private http2Manager: HTTP2SessionManager | null = null;

  constructor(instanceConfig: BridgeRequestConfig = {}) {
    this.defaults = instanceConfig;
    this.interceptors = {
      request: new InterceptorManager<BridgeRequestConfig>(),
      response: new InterceptorManager<BridgeResponse>(),
    };
  }

  /**
   * Set a rate limiter on this instance. Pass false to disable.
   */
  setRateLimiter(config: boolean | Partial<RateLimitConfig>): void {
    if (config === false) {
      this.rateLimiter = null;
      return;
    }
    const resolved = resolveRateLimitConfig(config);
    this.rateLimiter = resolved ? new RateLimiter(resolved) : null;
  }

  /**
   * Set a circuit breaker on this instance.
   */
  setCircuitBreaker(config: boolean | Partial<CircuitBreakerConfig>): void {
    const resolved = resolveCircuitBreakerConfig(config);
    this.circuitBreaker = resolved ? new CircuitBreaker(resolved) : null;
  }

  /**
   * Set concurrency control on this instance.
   */
  setConcurrency(config: number | Partial<ConcurrencyConfig>): void {
    const resolved = resolveConcurrencyConfig(config);
    this.concurrencyManager = resolved ? new ConcurrencyManager(resolved) : null;
  }

  /**
   * Get the circuit breaker state (returns null if not enabled).
   */
  getCircuitState(): CircuitState | null {
    return this.circuitBreaker ? this.circuitBreaker.getState() : null;
  }

  /**
   * Set a response cache on this instance. Pass false to disable.
   */
  setCache(config: boolean | Partial<CacheConfig>): void {
    if (config === false) {
      this.responseCache = null;
      return;
    }
    const resolved = resolveCacheConfig(config);
    this.responseCache = resolved ? new ResponseCache(resolved) : null;
  }

  /**
   * Clear the response cache.
   */
  clearCache(): void {
    if (this.responseCache) {
      this.responseCache.clear();
    }
  }

  /**
   * Enable or disable request deduplication.
   */
  setDeduplication(enabled: boolean): void {
    if (enabled) {
      this.deduplicator = this.deduplicator || new RequestDeduplicator();
    } else {
      this.deduplicator = null;
    }
  }

  // ─── v7.0.0 Instance Methods ──────────────────────────────────────────────

  /**
   * Enable or disable DNS caching.
   */
  setDNSCache(config: boolean | Partial<DNSCacheConfig>): void {
    if (config === false) {
      this.dnsCache = null;
      return;
    }
    const resolved = resolveDNSCacheConfig(config);
    this.dnsCache = resolved ? new DNSCache(resolved) : null;
  }

  /**
   * Clear the DNS cache.
   */
  clearDNSCache(): void {
    if (this.dnsCache) {
      this.dnsCache.clear();
    }
  }

  /**
   * Enable or disable the cookie jar.
   */
  setCookieJar(config: boolean | Partial<CookieJarConfig>): void {
    if (config === false) {
      this.cookieJar = null;
      return;
    }
    const resolved = resolveCookieJarConfig(config);
    this.cookieJar = resolved ? new CookieJar(resolved) : null;
  }

  /**
   * Clear all cookies.
   */
  clearCookies(): void {
    if (this.cookieJar) {
      this.cookieJar.clear();
    }
  }

  /**
   * Add a middleware to the pipeline.
   */
  useMiddleware(handler: MiddlewareFunction): void;
  useMiddleware(name: string, handler: MiddlewareFunction): void;
  useMiddleware(nameOrHandler: string | MiddlewareFunction, handler?: MiddlewareFunction): void {
    if (typeof nameOrHandler === 'string') {
      this.middlewarePipeline.use(nameOrHandler, handler!);
    } else {
      this.middlewarePipeline.use(nameOrHandler);
    }
  }

  /**
   * Remove a middleware by name.
   */
  removeMiddleware(name: string): boolean {
    return this.middlewarePipeline.remove(name);
  }

  /**
   * Clear all middleware.
   */
  clearMiddleware(): void {
    this.middlewarePipeline.clear();
  }

  /**
   * Close all HTTP/2 sessions.
   */
  closeHTTP2Sessions(): void {
    if (this.http2Manager) {
      this.http2Manager.closeAll();
    }
  }

  /**
   * The main request method. All convenience methods route here.
   * Integrates rate limiting, circuit breaker, concurrency control, caching, deduplication,
   * cookie jar, DNS cache, middleware, and HTTP/2.
   */
  async request<T = unknown>(
    configOrUrl: string | BridgeRequestConfig,
    config?: BridgeRequestConfig
  ): Promise<BridgeResponse<T>> {
    let finalConfig: BridgeRequestConfig;

    if (typeof configOrUrl === 'string') {
      finalConfig = mergeConfig(this.defaults, config, { url: configOrUrl });
    } else {
      finalConfig = mergeConfig(this.defaults, configOrUrl);
    }

    const method = (finalConfig.method || 'GET').toUpperCase();
    const fullURL = buildFullURL(finalConfig);

    // v6.0.0: Check cache first
    if (this.responseCache && this.responseCache.isCacheableMethod(method)) {
      const cacheKey = ResponseCache.key(method, fullURL);
      const cached = this.responseCache.get(cacheKey);
      if (cached) {
        return cached as BridgeResponse<T>;
      }
    }

    // Circuit breaker check
    if (this.circuitBreaker && !this.circuitBreaker.allowRequest()) {
      throw createError(
        'Circuit breaker is open — request rejected',
        finalConfig,
        'ERR_CIRCUIT_OPEN'
      );
    }

    // Rate limiting
    if (this.rateLimiter) {
      await this.rateLimiter.acquire(finalConfig.signal);
    }

    // v7.0.0: Cookie jar — inject Cookie header before request
    if (this.cookieJar) {
      try {
        const urlObj = new URL(fullURL);
        const cookieHeader = this.cookieJar.getCookieHeader(
          urlObj.hostname,
          urlObj.pathname,
          urlObj.protocol === 'https:'
        );
        if (cookieHeader) {
          finalConfig = mergeConfig(finalConfig, {
            headers: { Cookie: cookieHeader },
          });
        }
      } catch {
        // Ignore URL parse errors; will be caught later in adapter
      }
    }

    // v7.0.0: Pass DNS cache and HTTP/2 manager via internal config
    const internalConfig = {
      ...finalConfig,
      _dnsCache: this.dnsCache,
      _http2Manager: this.http2Manager,
    } as BridgeRequestConfig & { _dnsCache?: DNSCache; _http2Manager?: HTTP2SessionManager };

    // Wrap the actual execution for concurrency control
    const executeInternal = async (): Promise<BridgeResponse<T>> => {
      // Run request interceptors (in order)
      const requestInterceptors: InterceptorHandler<BridgeRequestConfig>[] = [];
      this.interceptors.request.forEach((handler) => {
        requestInterceptors.push(handler);
      });

      let currentConfig = internalConfig as BridgeRequestConfig;
      for (const interceptor of requestInterceptors) {
        try {
          currentConfig = await interceptor.fulfilled(currentConfig);
        } catch (err) {
          if (interceptor.rejected) {
            currentConfig = (await interceptor.rejected(err)) as BridgeRequestConfig;
          } else {
            throw err;
          }
        }
      }

      // v7.0.0: Middleware pipeline wrapping
      const coreRequest = async (): Promise<BridgeResponse<T>> => {
        // Execute the request
        let response: BridgeResponse<T>;
        try {
          response = (await httpAdapter(currentConfig)) as BridgeResponse<T>;
        } catch (err) {
          // Record failure in circuit breaker
          if (this.circuitBreaker) {
            this.circuitBreaker.recordFailure();
          }

          // Run response interceptors' rejected handlers on error
          const responseInterceptors: InterceptorHandler<BridgeResponse>[] = [];
          this.interceptors.response.forEach((handler) => {
            responseInterceptors.push(handler);
          });

          let caughtError: unknown = err;
          for (const interceptor of responseInterceptors) {
            if (interceptor.rejected) {
              try {
                const result = await interceptor.rejected(caughtError);
                // If the rejected handler returns a response, treat it as resolved
                if (result && typeof result === 'object' && 'status' in result) {
                  return result as BridgeResponse<T>;
                }
                caughtError = result;
              } catch (e) {
                caughtError = e;
              }
            }
          }
          throw caughtError;
        }

        // Record success in circuit breaker
        if (this.circuitBreaker) {
          this.circuitBreaker.recordSuccess();
        }

        // v7.0.0: Cookie jar — extract Set-Cookie from response
        if (this.cookieJar && response.headers) {
          try {
            const urlObj = new URL(fullURL);
            // Set-Cookie headers may be combined with commas by Node.js
            // We need to handle both single and multiple Set-Cookie values
            const setCookie = response.headers['set-cookie'];
            if (setCookie) {
              // If the adapter stored raw headers, they'd be joined by ', '
              // but Set-Cookie can contain commas in dates, so we split carefully
              const cookies = setCookie.split(/,\s*(?=[A-Za-z0-9_\-]+=)/);
              this.cookieJar.setCookies(cookies, urlObj.hostname, urlObj.pathname);
            }
          } catch {
            // Ignore cookie parsing errors
          }
        }

        // Run response interceptors (in order)
        const responseInterceptors: InterceptorHandler<BridgeResponse>[] = [];
        this.interceptors.response.forEach((handler) => {
          responseInterceptors.push(handler);
        });

        let currentResponse: BridgeResponse = response;
        for (const interceptor of responseInterceptors) {
          try {
            currentResponse = await interceptor.fulfilled(currentResponse);
          } catch (err) {
            if (interceptor.rejected) {
              const result = await interceptor.rejected(err);
              if (result && typeof result === 'object' && 'status' in result) {
                currentResponse = result as BridgeResponse;
              }
            } else {
              throw err;
            }
          }
        }

        // v6.0.0: Cache the response
        if (this.responseCache && this.responseCache.isCacheableMethod(method)) {
          const cacheKey = ResponseCache.key(method, fullURL);
          this.responseCache.set(cacheKey, currentResponse);
        }

        return currentResponse as BridgeResponse<T>;
      };

      // v7.0.0: Execute through middleware pipeline if any middleware are registered
      if (this.middlewarePipeline.length > 0) {
        const ctx: MiddlewareContext = {
          config: currentConfig,
          metadata: {},
        };

        let result: BridgeResponse<T> | undefined;
        await this.middlewarePipeline.execute(ctx, async (mwCtx) => {
          // Core handler: update config from context (middleware may have modified it)
          currentConfig = mwCtx.config;
          result = await coreRequest();
          mwCtx.response = result;
        });

        if (result) return result;
        // If middleware short-circuited and set a response
        if (ctx.response) return ctx.response as BridgeResponse<T>;
        throw createError('Middleware pipeline did not produce a response', currentConfig, 'ERR_MIDDLEWARE');
      }

      return coreRequest();
    };

    // v6.0.0: Wrap with deduplication if enabled
    const executeWithConcurrency = (): Promise<BridgeResponse<T>> => {
      if (this.concurrencyManager) {
        return this.concurrencyManager.execute(executeInternal);
      }
      return executeInternal();
    };

    // v6.0.0: Deduplication — only for safe/idempotent methods
    if (this.deduplicator && ['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const dedupKey = RequestDeduplicator.key(method, fullURL);
      return this.deduplicator.execute(
        dedupKey,
        executeWithConcurrency
      ) as Promise<BridgeResponse<T>>;
    }

    return executeWithConcurrency();
  }

  /**
   * Returns the full URI that would be used for the request.
   */
  getUri(config?: BridgeRequestConfig): string {
    const merged = mergeConfig(this.defaults, config);
    return buildFullURL(merged);
  }

  // ─── Convenience Methods (no body) ───────────────────────────────────────────

  get<T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>> {
    return this.request<T>(url, { ...config, method: 'GET' });
  }

  delete<T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>> {
    return this.request<T>(url, { ...config, method: 'DELETE' });
  }

  head<T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>> {
    return this.request<T>(url, { ...config, method: 'HEAD' });
  }

  options<T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>> {
    return this.request<T>(url, { ...config, method: 'OPTIONS' });
  }

  // ─── Convenience Methods (with body) ─────────────────────────────────────────

  post<T = unknown>(url: string, data?: unknown, config?: BridgeRequestConfig): Promise<BridgeResponse<T>> {
    return this.request<T>(url, { ...config, method: 'POST', data });
  }

  put<T = unknown>(url: string, data?: unknown, config?: BridgeRequestConfig): Promise<BridgeResponse<T>> {
    return this.request<T>(url, { ...config, method: 'PUT', data });
  }

  patch<T = unknown>(url: string, data?: unknown, config?: BridgeRequestConfig): Promise<BridgeResponse<T>> {
    return this.request<T>(url, { ...config, method: 'PATCH', data });
  }

  // ─── Instance Creation ───────────────────────────────────────────────────────

  create(config?: BridgeRequestConfig): BridgeInstance {
    return createBridgeInstance(mergeConfig(this.defaults, config));
  }
}

// ─── Build a callable instance ─────────────────────────────────────────────────

export function createBridgeInstance(config: BridgeRequestConfig = {}): BridgeInstance {
  const context = new Bridge(config);

  // Create the callable function
  const instance = function bridgeCall(
    configOrUrl: string | BridgeRequestConfig,
    maybeConfig?: BridgeRequestConfig
  ) {
    return context.request(configOrUrl, maybeConfig);
  } as BridgeInstance;

  // Copy Bridge.prototype methods onto the instance
  const proto = Bridge.prototype;
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (descriptor) {
      const value = descriptor.value;
      if (typeof value === 'function') {
        (instance as unknown as Record<string, unknown>)[key] = value.bind(context);
      }
    }
  }

  // Copy instance properties
  instance.defaults = context.defaults;
  instance.interceptors = context.interceptors;

  // Override create to return a proper callable instance
  instance.create = (newConfig?: BridgeRequestConfig) => {
    return createBridgeInstance(mergeConfig(config, newConfig));
  };

  return instance;
}
