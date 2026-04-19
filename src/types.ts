// ─── Core Types ────────────────────────────────────────────────────────────────

import type { RequestTimeline } from './timeline';
import type { CircuitState } from './circuit-breaker';
import type { RequestSigningConfig } from './signing';
import type { CacheConfig } from './cache';
import type { ProxyConfig } from './proxy';
import type { DNSCacheConfig } from './dns-cache';
import type { CookieJarConfig } from './cookie';
import type { HTTP2Config } from './http2';
import type { MiddlewareFunction } from './middleware';

export type Method =
  | 'get' | 'GET'
  | 'delete' | 'DELETE'
  | 'head' | 'HEAD'
  | 'options' | 'OPTIONS'
  | 'post' | 'POST'
  | 'put' | 'PUT'
  | 'patch' | 'PATCH';

export type ResponseType = 'arraybuffer' | 'json' | 'text' | 'stream';

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  retries: number;
  /** Initial delay in ms before first retry (default: 300) */
  delay: number;
  /** Maximum delay in ms between retries (default: 10000) */
  maxDelay: number;
  /** Backoff multiplier (default: 2) */
  backoffFactor: number;
  /** Which HTTP methods to retry (default: GET, HEAD, OPTIONS, PUT, DELETE) */
  retryableMethods: Method[];
  /** Which HTTP status codes to retry (default: 408, 429, 500, 502, 503, 504) */
  retryableStatuses: number[];
  /** Custom condition for retry — return true to retry */
  retryCondition?: (error: BridgeError) => boolean;
}

export interface TLSConfig {
  /** Reject connections with unverified certificates (default: true) */
  rejectUnauthorized?: boolean;
  /** Custom Certificate Authority certificates (PEM format) */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Client certificate (PEM format) for mTLS */
  cert?: string | Buffer | Array<string | Buffer>;
  /** Client private key (PEM format) for mTLS */
  key?: string | Buffer;
  /** PFX/PKCS12 certificate bundle */
  pfx?: string | Buffer;
  /** Passphrase for the private key or PFX */
  passphrase?: string;
  /** Minimum TLS version (default: 'TLSv1.2') */
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** Allowed cipher suites */
  ciphers?: string;
  /** Expected server certificate fingerprint (SHA-256 pin for certificate pinning) */
  certFingerprint?: string;
}

// ─── Rate Limit Types ──────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the time window (default: 10) */
  maxRequests: number;
  /** Time window in milliseconds (default: 1000 = 1 second) */
  windowMs: number;
}

// ─── Circuit Breaker Types ─────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Number of failures before the circuit opens (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting to half-open the circuit (default: 30000) */
  resetTimeout: number;
  /** Number of successful requests in half-open state to close the circuit (default: 1) */
  halfOpenRequests: number;
  /** Optional callback when circuit state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  /** Optional fallback function invoked when the circuit is open.
   *  Return a BridgeResponse to gracefully degrade instead of throwing. */
  fallback?: (error: Error) => BridgeResponse | Promise<BridgeResponse>;
}

// ─── Concurrency Types ─────────────────────────────────────────────────────────

export interface ConcurrencyConfig {
  /** Maximum number of concurrent requests (default: 10) */
  maxConcurrent: number;
  /** Maximum time in ms a request can wait in the concurrency queue before being rejected (default: 0 = no limit).
   *  Prevents indefinite queuing in worst-case overload scenarios. */
  queueTimeout?: number;
}

// ─── Progress Types ────────────────────────────────────────────────────────────

export interface ProgressEvent {
  /** Number of bytes transferred so far */
  loaded: number;
  /** Total number of bytes to transfer (may be 0 if unknown) */
  total: number;
  /** Progress percentage (0-100, or -1 if total is unknown) */
  progress: number;
  /** Estimated transfer rate in bytes per second */
  rate: number;
  /** Estimated time remaining in milliseconds (-1 if unknown) */
  estimated: number;
}

// ─── Event Hooks Types ─────────────────────────────────────────────────────────

export interface EventHooks {
  /** Called before a request is sent (after interceptors) */
  onRequest?: (config: BridgeRequestConfig) => void;
  /** Called when a response is received (before interceptors) */
  onResponse?: (response: BridgeResponse) => void;
  /** Called when a request fails */
  onError?: (error: BridgeError) => void;
  /** Called before a retry attempt */
  onRetry?: (attempt: number, error: BridgeError, delay: number) => void;
}

export interface BridgeRequestConfig {
  url?: string;
  method?: Method;
  baseURL?: string;
  headers?: Record<string, string | number | boolean>;
  params?: Record<string, unknown> | URLSearchParams;
  data?: unknown;
  timeout?: number;
  /** Separate timeout for the response body to be fully received (ms) */
  responseTimeout?: number;
  responseType?: ResponseType;
  maxContentLength?: number;
  maxBodyLength?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  validateStatus?: (status: number) => boolean;
  auth?: {
    username: string;
    password: string;
  };
  decompress?: boolean;

  // Security options
  allowPrivateNetworks?: boolean;
  maxHeaderSize?: number;
  /** Enforce HTTPS — reject all non-HTTPS requests */
  enforceHttps?: boolean;
  /** Enable DNS-based SSRF protection (resolves hostname and validates IP before connecting) */
  dnsProtection?: boolean;

  // ─── v5.0.0 Security Features ──────────────────────────────────────────────
  /** Allowlist of domains. If set, only requests to these domains are allowed. Supports wildcard subdomains (e.g. '*.example.com'). */
  allowedDomains?: string[];
  /** Blocklist of domains. Requests to these domains are blocked. Supports wildcard subdomains (e.g. '*.evil.com'). */
  blockedDomains?: string[];
  /** Strip sensitive headers (Authorization, Cookie, Proxy-Authorization) on cross-origin redirects (default: true) */
  stripSensitiveHeadersOnRedirect?: boolean;
  /** Allow HTTPS to HTTP downgrade on redirects (default: false — blocks downgrade) */
  allowHttpsDowngrade?: boolean;

  // ─── v6.0.0 Security Features ──────────────────────────────────────────────
  /** Expected SHA-256 hash of the response body. If set, response integrity is verified. */
  expectedHash?: string;
  /** HMAC request signing configuration. Signs outgoing requests with HMAC. */
  requestSigning?: RequestSigningConfig;
  /** Expected Content-Type of the response. If set, response Content-Type is validated (prefix match). */
  expectedContentType?: string;
  /** Auto-inject an Idempotency-Key header. Pass true for auto-generated UUID, or a string for a custom key. */
  idempotencyKey?: boolean | string;
  /** Respect Retry-After headers from server responses during retry (default: true when retry is enabled) */
  respectRetryAfter?: boolean;

  // ─── v7.0.0 Features ──────────────────────────────────────────────────────

  /** HTTP proxy configuration for tunneling requests through a proxy server. */
  proxy?: ProxyConfig | false;
  /** Enable HTTP/2 for HTTPS requests. Pass true for defaults or an HTTP2Config object. */
  http2?: boolean | Partial<HTTP2Config>;

  // ─── v9.0.0 Resilience Features ─────────────────────────────────────────────

  /** Total timeout in ms covering the entire request lifecycle including all retries.
   *  Unlike `timeout` (which covers a single request attempt), this caps the total wall-clock time.
   *  Prevents unbounded retry loops in worst-case scenarios. */
  totalTimeout?: number;
  /** Fallback function invoked when all retries are exhausted, the circuit breaker is open,
   *  or a total timeout fires. Return a BridgeResponse to gracefully degrade instead of throwing. */
  fallback?: (error: Error) => BridgeResponse | Promise<BridgeResponse>;
  /** Priority for concurrency queue ordering. Higher values are processed first (default: 0).
   *  Use to ensure critical requests are prioritized in worst-case load. */
  priority?: number;

  // ─── v8.0.0 Security Features ──────────────────────────────────────────────

  /** Enable strict security mode — turns on all security features with the most secure defaults.
   *  When enabled: enforces HTTPS, enables DNS protection, blocks private networks,
   *  blocks IDN homograph attacks, enables safe JSON parsing, validates Content-Length,
   *  limits response headers, and enforces TLS 1.3. */
  strictSecurity?: boolean;
  /** Block potential IDN homograph attacks in hostnames (default: false, true when strictSecurity is on) */
  blockHomographAttacks?: boolean;
  /** Maximum number of response headers allowed (default: 100). Prevents header flooding attacks. */
  maxResponseHeaders?: number;
  /** Maximum total size of response headers in bytes (default: 65536). Prevents header flooding. */
  maxResponseHeaderSize?: number;
  /** Maximum decompression ratio (compressed:decompressed) to prevent decompression bomb attacks (default: 100). */
  maxDecompressionRatio?: number;
  /** Enable safe JSON parsing that strips __proto__, constructor, and prototype properties
   *  to prevent prototype pollution attacks (default: false, true when strictSecurity is on). */
  safeJsonParsing?: boolean;
  /** Validate that response body size matches Content-Length header to detect truncation/smuggling
   *  (default: false, true when strictSecurity is on). */
  validateContentLength?: boolean;

  // Retry options
  /** Enable automatic retry with exponential backoff. Pass true for defaults or a RetryConfig. */
  retry?: boolean | Partial<RetryConfig>;

  // TLS/SSL options
  tls?: TLSConfig;

  // Transformers
  /** Transform request data before sending */
  transformRequest?: Array<(data: unknown, headers: Record<string, string>) => unknown>;
  /** Transform response data after receiving */
  transformResponse?: Array<(data: unknown) => unknown>;

  // Observability
  /** Enable automatic X-Request-ID header injection */
  requestId?: boolean | string;

  // ─── v4.0.0 Features ──────────────────────────────────────────────────────

  /** Upload progress callback */
  onUploadProgress?: (event: ProgressEvent) => void;
  /** Download progress callback */
  onDownloadProgress?: (event: ProgressEvent) => void;

  /** Enable request timeline/metrics collection */
  collectTimeline?: boolean;

  /** Event lifecycle hooks */
  hooks?: EventHooks;
}

export interface BridgeResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: BridgeRequestConfig;
  /** Request timing metrics (only present when collectTimeline: true) */
  timeline?: RequestTimeline;
}

export interface BridgeError extends Error {
  config: BridgeRequestConfig;
  code?: string;
  response?: BridgeResponse;
  isAxiosError: boolean;
  isBridgeError: boolean;
}

// ─── Interceptor Types ─────────────────────────────────────────────────────────

export interface InterceptorHandler<V> {
  fulfilled: (value: V) => V | Promise<V>;
  rejected?: (error: unknown) => unknown;
}

// ─── Cancel Types ──────────────────────────────────────────────────────────────

export interface CancelTokenSource {
  token: CancelToken;
  cancel: (message?: string) => void;
}

export interface CancelToken {
  promise: Promise<Cancel>;
  reason?: Cancel;
  throwIfRequested(): void;
}

export interface Cancel {
  message?: string;
}

// ─── Instance Types ────────────────────────────────────────────────────────────

export interface BridgeInstance {
  <T = unknown>(config: BridgeRequestConfig): Promise<BridgeResponse<T>>;
  <T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>>;

  defaults: BridgeRequestConfig;
  interceptors: {
    request: InterceptorManager<BridgeRequestConfig>;
    response: InterceptorManager<BridgeResponse>;
  };

  request<T = unknown>(config: BridgeRequestConfig): Promise<BridgeResponse<T>>;
  get<T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>>;
  delete<T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>>;
  head<T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>>;
  options<T = unknown>(url: string, config?: BridgeRequestConfig): Promise<BridgeResponse<T>>;
  post<T = unknown>(url: string, data?: unknown, config?: BridgeRequestConfig): Promise<BridgeResponse<T>>;
  put<T = unknown>(url: string, data?: unknown, config?: BridgeRequestConfig): Promise<BridgeResponse<T>>;
  patch<T = unknown>(url: string, data?: unknown, config?: BridgeRequestConfig): Promise<BridgeResponse<T>>;

  getUri(config?: BridgeRequestConfig): string;
  create(config?: BridgeRequestConfig): BridgeInstance;

  /** Set a rate limiter on this instance */
  setRateLimiter(config: boolean | Partial<RateLimitConfig>): void;
  /** Set a circuit breaker on this instance */
  setCircuitBreaker(config: boolean | Partial<CircuitBreakerConfig>): void;
  /** Set concurrency control on this instance */
  setConcurrency(config: number | Partial<ConcurrencyConfig>): void;
  /** Get the circuit breaker state (returns null if not enabled) */
  getCircuitState(): CircuitState | null;

  // ─── v6.0.0 Instance Methods ─────────────────────────────────────────────
  /** Set a response cache on this instance. Pass false to disable. */
  setCache(config: boolean | Partial<CacheConfig>): void;
  /** Clear the response cache. */
  clearCache(): void;
  /** Enable or disable request deduplication. */
  setDeduplication(enabled: boolean): void;

  // ─── v7.0.0 Instance Methods ─────────────────────────────────────────────
  /** Enable or disable DNS caching. Pass true for defaults or a DNSCacheConfig object. */
  setDNSCache(config: boolean | Partial<DNSCacheConfig>): void;
  /** Clear the DNS cache. */
  clearDNSCache(): void;
  /** Enable or disable the cookie jar. Pass true for defaults or a CookieJarConfig object. */
  setCookieJar(config: boolean | Partial<CookieJarConfig>): void;
  /** Clear all cookies. */
  clearCookies(): void;
  /** Add a middleware to the pipeline. */
  useMiddleware(handler: MiddlewareFunction): void;
  useMiddleware(name: string, handler: MiddlewareFunction): void;
  /** Remove a middleware by name. */
  removeMiddleware(name: string): boolean;
  /** Clear all middleware. */
  clearMiddleware(): void;
  /** Close all HTTP/2 sessions. */
  closeHTTP2Sessions(): void;
}

export interface InterceptorManager<V> {
  use(
    onFulfilled: (value: V) => V | Promise<V>,
    onRejected?: (error: unknown) => unknown
  ): number;
  eject(id: number): void;
  forEach(fn: (handler: InterceptorHandler<V>) => void): void;
}

// ─── Static Types ──────────────────────────────────────────────────────────────

export interface BridgeStatic extends BridgeInstance {
  create(config?: BridgeRequestConfig): BridgeInstance;
  CancelToken: CancelTokenStatic;
  isCancel(value: unknown): boolean;
  isBridgeError(value: unknown): boolean;
  isAxiosError(value: unknown): boolean;
  all<T>(values: Array<T | Promise<T>>): Promise<T[]>;
  spread<T, R>(callback: (...args: T[]) => R): (array: T[]) => R;

  /** Set a rate limiter on this instance */
  setRateLimiter(config: boolean | Partial<RateLimitConfig>): void;
  /** Set a circuit breaker on this instance */
  setCircuitBreaker(config: boolean | Partial<CircuitBreakerConfig>): void;
  /** Set concurrency control on this instance */
  setConcurrency(config: number | Partial<ConcurrencyConfig>): void;
  /** Get the circuit breaker state (returns null if not enabled) */
  getCircuitState(): CircuitState | null;

  // ─── v6.0.0 Instance Methods ─────────────────────────────────────────────
  /** Set a response cache on this instance. Pass false to disable. */
  setCache(config: boolean | Partial<CacheConfig>): void;
  /** Clear the response cache. */
  clearCache(): void;
  /** Enable or disable request deduplication. */
  setDeduplication(enabled: boolean): void;

  // ─── v7.0.0 Instance Methods ─────────────────────────────────────────────
  /** Enable or disable DNS caching. */
  setDNSCache(config: boolean | Partial<DNSCacheConfig>): void;
  /** Clear the DNS cache. */
  clearDNSCache(): void;
  /** Enable or disable the cookie jar. */
  setCookieJar(config: boolean | Partial<CookieJarConfig>): void;
  /** Clear all cookies. */
  clearCookies(): void;
  /** Add a middleware to the pipeline. */
  useMiddleware(handler: MiddlewareFunction): void;
  useMiddleware(name: string, handler: MiddlewareFunction): void;
  /** Remove a middleware by name. */
  removeMiddleware(name: string): boolean;
  /** Clear all middleware. */
  clearMiddleware(): void;
  /** Close all HTTP/2 sessions. */
  closeHTTP2Sessions(): void;
}

export interface CancelTokenStatic {
  new (executor: (cancel: (message?: string) => void) => void): CancelToken;
  source(): CancelTokenSource;
}
