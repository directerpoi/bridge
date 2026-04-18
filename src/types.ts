// ─── Core Types ────────────────────────────────────────────────────────────────

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
}

export interface BridgeResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: BridgeRequestConfig;
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
}

export interface CancelTokenStatic {
  new (executor: (cancel: (message?: string) => void) => void): CancelToken;
  source(): CancelTokenSource;
}
