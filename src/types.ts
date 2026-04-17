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

export interface BridgeRequestConfig {
  url?: string;
  method?: Method;
  baseURL?: string;
  headers?: Record<string, string | number | boolean>;
  params?: Record<string, unknown> | URLSearchParams;
  data?: unknown;
  timeout?: number;
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
