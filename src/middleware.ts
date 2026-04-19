// ─── Middleware Pipeline ─────────────────────────────────────────────────────────

import { BridgeRequestConfig, BridgeResponse } from './types';

/**
 * Context object passed through the middleware pipeline.
 * Carries the request config and final response, plus a generic metadata bag.
 */
export interface MiddlewareContext {
  /** The request configuration (may be modified by middleware) */
  config: BridgeRequestConfig;
  /** The response (populated after the request is executed) */
  response?: BridgeResponse;
  /** Arbitrary metadata bag for passing data between middleware */
  metadata: Record<string, unknown>;
}

/**
 * A middleware function.
 * Receives the context and a `next` function to continue the pipeline.
 * Must call `next()` exactly once to proceed (or not call it to short-circuit).
 */
export type MiddlewareFunction = (
  ctx: MiddlewareContext,
  next: () => Promise<void>
) => Promise<void> | void;

/**
 * Named middleware descriptor for better debugging and management.
 */
export interface MiddlewareDescriptor {
  /** Unique name for identification */
  name: string;
  /** The middleware function */
  handler: MiddlewareFunction;
}

/**
 * Composable middleware pipeline.
 * Middleware are executed in registration order before the request,
 * and in reverse order after the request (like an onion/koa model).
 */
export class MiddlewarePipeline {
  private middleware: MiddlewareDescriptor[] = [];

  /**
   * Add a middleware to the pipeline.
   * @param nameOrHandler - Name string or middleware function
   * @param handler - Middleware function (when name is provided)
   */
  use(handler: MiddlewareFunction): void;
  use(name: string, handler: MiddlewareFunction): void;
  use(
    nameOrHandler: string | MiddlewareFunction,
    handler?: MiddlewareFunction
  ): void {
    if (typeof nameOrHandler === 'string') {
      if (!handler) throw new Error('Middleware handler is required');
      this.middleware.push({ name: nameOrHandler, handler });
    } else {
      this.middleware.push({
        name: `middleware_${this.middleware.length}`,
        handler: nameOrHandler,
      });
    }
  }

  /**
   * Remove a middleware by name.
   */
  remove(name: string): boolean {
    const idx = this.middleware.findIndex((m) => m.name === name);
    if (idx >= 0) {
      this.middleware.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Execute the middleware pipeline.
   * The `coreHandler` is the actual request execution logic — it runs at the center.
   */
  async execute(
    ctx: MiddlewareContext,
    coreHandler: (ctx: MiddlewareContext) => Promise<void>
  ): Promise<void> {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error('next() called multiple times');
      }
      index = i;

      if (i < this.middleware.length) {
        const mw = this.middleware[i];
        await mw.handler(ctx, () => dispatch(i + 1));
      } else {
        // End of middleware chain — run the core handler
        await coreHandler(ctx);
      }
    };

    await dispatch(0);
  }

  /**
   * Get the number of registered middleware.
   */
  get length(): number {
    return this.middleware.length;
  }

  /**
   * Get names of all registered middleware.
   */
  getNames(): string[] {
    return this.middleware.map((m) => m.name);
  }

  /**
   * Clear all middleware.
   */
  clear(): void {
    this.middleware = [];
  }
}
