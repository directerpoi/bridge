import { BridgeRequestConfig, BridgeError, BridgeResponse } from './types';

/**
 * Creates a BridgeError with the standard shape (compatible with AxiosError).
 */
export function createError(
  message: string,
  config: BridgeRequestConfig,
  code?: string,
  response?: BridgeResponse
): BridgeError {
  const error = new Error(message) as BridgeError;
  error.config = config;
  error.code = code;
  error.response = response;
  error.isAxiosError = true;   // axios compat
  error.isBridgeError = true;
  error.name = 'BridgeError';
  // Capture proper stack trace
  if ((Error as { captureStackTrace?: Function }).captureStackTrace) {
    (Error as { captureStackTrace: Function }).captureStackTrace(error, createError);
  }
  return error;
}

/**
 * Checks whether a value is a BridgeError.
 */
export function isBridgeError(value: unknown): value is BridgeError {
  return (
    value instanceof Error &&
    (value as BridgeError).isBridgeError === true
  );
}
