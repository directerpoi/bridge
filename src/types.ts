// ─── Core Types ────────────────────────────────────────────────────────────────

import type { RequestTimeline } from './timeline';
import type { CircuitState } from './circuit-breaker';

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
}

// ─── Concurrency Types ─────────────────────────────────────────────────────────

export interface ConcurrencyConfig {
  /** Maximum number of concurrent requests (default: 10) */
  maxConcurrent: number;
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
}

export interface CancelTokenStatic {
  new (executor: (cancel: (message?: string) => void) => void): CancelToken;
  source(): CancelTokenSource;
}
