import { createBridgeInstance } from './bridge';
import { CancelToken, isCancel } from './cancel';
import { isBridgeError } from './error';
import {
  BridgeRequestConfig,
  BridgeResponse,
  BridgeError,
  BridgeInstance,
  BridgeStatic,
  Method,
  ResponseType,
  CancelTokenSource,
  InterceptorManager,
  RetryConfig,
  TLSConfig,
} from './types';

// ─── Create Default Instance ───────────────────────────────────────────────────

const bridge = createBridgeInstance({
  headers: {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'bridge/3.0.0',
  },
  timeout: 0,
  responseType: 'json',
  maxRedirects: 5,
  maxContentLength: 50 * 1024 * 1024,
  maxBodyLength: 50 * 1024 * 1024,
  validateStatus: (status: number) => status >= 200 && status < 300,
}) as BridgeStatic;

// ─── Attach Static Utilities ───────────────────────────────────────────────────

bridge.CancelToken = CancelToken as unknown as BridgeStatic['CancelToken'];
bridge.isCancel = isCancel;
bridge.isBridgeError = isBridgeError;
bridge.isAxiosError = isBridgeError; // axios compat

bridge.all = function all<T>(values: Array<T | Promise<T>>): Promise<T[]> {
  return Promise.all(values);
};

bridge.spread = function spread<T, R>(callback: (...args: T[]) => R): (array: T[]) => R {
  return function wrap(arr: T[]) {
    return callback(...arr);
  };
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export default bridge;
export { bridge };

// Named exports for tree-shaking and convenience
export { createBridgeInstance as create };
export { CancelToken, isCancel };
export { isBridgeError, isBridgeError as isAxiosError };

// Re-export types
export type {
  BridgeRequestConfig,
  BridgeResponse,
  BridgeError,
  BridgeInstance,
  BridgeStatic,
  Method,
  ResponseType,
  CancelTokenSource,
  InterceptorManager,
  RetryConfig,
  TLSConfig,
};

// CommonJS compatibility
module.exports = bridge;
module.exports.default = bridge;
module.exports.bridge = bridge;
module.exports.create = createBridgeInstance;
module.exports.CancelToken = CancelToken;
module.exports.isCancel = isCancel;
module.exports.isBridgeError = isBridgeError;
module.exports.isAxiosError = isBridgeError;
