import { Cancel, CancelToken as ICancelToken, CancelTokenSource, CancelTokenStatic as ICancelTokenStatic } from './types';

class CancelImpl implements Cancel {
  message?: string;
  constructor(message?: string) {
    this.message = message;
  }
}

/**
 * CancelToken implementation compatible with the axios CancelToken API.
 * Also supports native AbortController interop.
 */
export class CancelToken implements ICancelToken {
  promise: Promise<Cancel>;
  reason?: Cancel;

  constructor(executor: (cancel: (message?: string) => void) => void) {
    let resolvePromise!: (value: Cancel) => void;
    this.promise = new Promise<Cancel>((resolve) => {
      resolvePromise = resolve;
    });

    executor((message?: string) => {
      // Prevent calling cancel more than once
      if (this.reason) return;
      this.reason = new CancelImpl(message);
      resolvePromise(this.reason);
    });
  }

  throwIfRequested(): void {
    if (this.reason) {
      throw this.reason;
    }
  }

  static source(): CancelTokenSource {
    let cancel!: (message?: string) => void;
    const token = new CancelToken((c) => {
      cancel = c;
    });
    return { token, cancel };
  }
}

/**
 * Returns true if the given value is a cancellation.
 */
export function isCancel(value: unknown): value is Cancel {
  return value instanceof CancelImpl;
}

// Export as the static interface shape
export const CancelTokenClass: ICancelTokenStatic = CancelToken as unknown as ICancelTokenStatic;
