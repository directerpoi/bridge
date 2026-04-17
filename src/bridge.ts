import { BridgeRequestConfig, BridgeResponse, BridgeInstance, InterceptorHandler } from './types';
import { InterceptorManager } from './interceptors';
import { httpAdapter } from './adapter';
import { mergeConfig, buildFullURL } from './utils';

/**
 * The Bridge HTTP client class.
 * API-compatible with axios — supports interceptors, defaults, and convenience methods.
 */
export class Bridge {
  defaults: BridgeRequestConfig;
  interceptors: {
    request: InterceptorManager<BridgeRequestConfig>;
    response: InterceptorManager<BridgeResponse>;
  };

  constructor(instanceConfig: BridgeRequestConfig = {}) {
    this.defaults = instanceConfig;
    this.interceptors = {
      request: new InterceptorManager<BridgeRequestConfig>(),
      response: new InterceptorManager<BridgeResponse>(),
    };
  }

  /**
   * The main request method. All convenience methods route here.
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

    // Run request interceptors (in order)
    const requestInterceptors: InterceptorHandler<BridgeRequestConfig>[] = [];
    this.interceptors.request.forEach((handler) => {
      requestInterceptors.push(handler);
    });

    let currentConfig = finalConfig;
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

    // Execute the request
    let response: BridgeResponse<T>;
    try {
      response = (await httpAdapter(currentConfig)) as BridgeResponse<T>;
    } catch (err) {
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

    return currentResponse as BridgeResponse<T>;
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
