import { InterceptorHandler, InterceptorManager as IInterceptorManager } from './types';

/**
 * Manages request/response interceptors, matching the axios interceptor API.
 */
export class InterceptorManager<V> implements IInterceptorManager<V> {
  private handlers: Array<InterceptorHandler<V> | null> = [];

  /**
   * Register a new interceptor.
   * @returns The ID used to eject this interceptor later.
   */
  use(
    fulfilled: (value: V) => V | Promise<V>,
    rejected?: (error: unknown) => unknown
  ): number {
    this.handlers.push({ fulfilled, rejected });
    return this.handlers.length - 1;
  }

  /**
   * Remove an interceptor by its ID.
   */
  eject(id: number): void {
    if (this.handlers[id]) {
      this.handlers[id] = null;
    }
  }

  /**
   * Iterate over all registered interceptors (skipping ejected ones).
   */
  forEach(fn: (handler: InterceptorHandler<V>) => void): void {
    for (const handler of this.handlers) {
      if (handler !== null) {
        fn(handler);
      }
    }
  }
}
