import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { URL } from 'url';
import { BridgeRequestConfig, BridgeResponse } from './types';
import { createError } from './error';
import { validateURL, sanitizeHeaders, checkContentLength } from './security';
import { buildFullURL } from './utils';

// ─── Default Config ────────────────────────────────────────────────────────────

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 0; // no timeout
const DEFAULT_MAX_CONTENT_LENGTH = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_BODY_LENGTH = 50 * 1024 * 1024;    // 50 MB

// ─── Adapter ───────────────────────────────────────────────────────────────────

export function httpAdapter(config: BridgeRequestConfig): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const fullURL = buildFullURL(config);
    let parsedURL: URL;

    try {
      parsedURL = validateURL(fullURL, config.allowPrivateNetworks ?? false);
    } catch (err) {
      reject(createError((err as Error).message, config, 'ERR_INVALID_URL'));
      return;
    }

    const method = (config.method || 'GET').toUpperCase();
    const headers = sanitizeHeaders(config.headers);
    const timeout = config.timeout ?? DEFAULT_TIMEOUT;
    const maxContentLength = config.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    const maxBodyLength = config.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;
    const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const decompress = config.decompress !== false;

    // Prepare request body
    let requestData: Buffer | string | undefined;
    if (config.data !== undefined && config.data !== null) {
      if (Buffer.isBuffer(config.data)) {
        requestData = config.data;
      } else if (typeof config.data === 'string') {
        requestData = config.data;
      } else {
        // Auto-serialize JSON
        requestData = JSON.stringify(config.data);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      // Check max body length
      const bodyLen = typeof requestData === 'string'
        ? Buffer.byteLength(requestData)
        : requestData.length;
      if (bodyLen > maxBodyLength) {
        reject(
          createError(
            `Request body size ${bodyLen} exceeds maxBodyLength ${maxBodyLength}`,
            config,
            'ERR_BODY_TOO_LARGE'
          )
        );
        return;
      }

      if (!headers['Content-Length'] && !headers['content-length']) {
        headers['Content-Length'] = String(
          typeof requestData === 'string' ? Buffer.byteLength(requestData) : requestData.length
        );
      }
    }

    // Accept-Encoding for automatic decompression
    if (decompress && !headers['Accept-Encoding'] && !headers['accept-encoding']) {
      headers['Accept-Encoding'] = 'gzip, deflate, br';
    }

    // Basic auth
    let auth: string | undefined;
    if (config.auth) {
      auth = `${config.auth.username}:${config.auth.password}`;
    }

    // Early abort check — before creating any request
    if (config.signal && config.signal.aborted) {
      reject(createError('Request aborted', config, 'ERR_CANCELED'));
      return;
    }

    const isHttps = parsedURL.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestOptions: http.RequestOptions = {
      hostname: parsedURL.hostname,
      port: parsedURL.port || (isHttps ? 443 : 80),
      path: parsedURL.pathname + parsedURL.search,
      method,
      headers,
      auth,
    };

    if (config.maxHeaderSize) {
      requestOptions.maxHeaderSize = config.maxHeaderSize;
    }

    let redirectCount = 0;

    function doRequest(reqOptions: http.RequestOptions, reqURL: URL): void {
      const req = (reqURL.protocol === 'https:' ? https : http).request(
        reqOptions,
        (res: http.IncomingMessage) => {
          const statusCode = res.statusCode || 0;

          // Handle redirects
          if (
            [301, 302, 303, 307, 308].includes(statusCode) &&
            res.headers.location
          ) {
            redirectCount++;
            if (redirectCount > maxRedirects) {
              reject(
                createError(
                  `Maximum redirects (${maxRedirects}) exceeded`,
                  config,
                  'ERR_MAX_REDIRECTS'
                )
              );
              req.destroy();
              return;
            }

            let redirectURL: URL;
            try {
              redirectURL = new URL(res.headers.location, reqURL);
            } catch {
              reject(
                createError(
                  `Invalid redirect URL: ${res.headers.location}`,
                  config,
                  'ERR_INVALID_URL'
                )
              );
              req.destroy();
              return;
            }

            // Validate redirect URL
            try {
              validateURL(redirectURL.href, config.allowPrivateNetworks ?? false);
            } catch (err) {
              reject(createError((err as Error).message, config, 'ERR_INVALID_URL'));
              req.destroy();
              return;
            }

            const redirectOptions: http.RequestOptions = {
              ...reqOptions,
              hostname: redirectURL.hostname,
              port: redirectURL.port || (redirectURL.protocol === 'https:' ? 443 : 80),
              path: redirectURL.pathname + redirectURL.search,
            };

            // 303 always becomes GET
            if (statusCode === 303) {
              redirectOptions.method = 'GET';
              delete (redirectOptions.headers as Record<string, string>)['Content-Length'];
              delete (redirectOptions.headers as Record<string, string>)['content-length'];
            }

            res.resume(); // Discard response body
            doRequest(redirectOptions, redirectURL);
            return;
          }

          // Set up response stream with decompression
          let responseStream: NodeJS.ReadableStream = res;
          const encoding = res.headers['content-encoding'];

          if (decompress && encoding) {
            if (encoding === 'gzip') {
              responseStream = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
              responseStream = res.pipe(zlib.createInflate());
            } else if (encoding === 'br') {
              responseStream = res.pipe(zlib.createBrotliDecompress());
            }
          }

          // Stream response type
          if (config.responseType === 'stream') {
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (value !== undefined) {
                responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
              }
            }

            const response: BridgeResponse = {
              data: responseStream as unknown,
              status: statusCode,
              statusText: res.statusMessage || '',
              headers: responseHeaders,
              config,
            };

            const validateStatus = config.validateStatus || defaultValidateStatus;
            if (validateStatus(statusCode)) {
              resolve(response);
            } else {
              reject(
                createError(
                  `Request failed with status code ${statusCode}`,
                  config,
                  'ERR_BAD_RESPONSE',
                  response
                )
              );
            }
            return;
          }

          // Buffer the response body
          const chunks: Buffer[] = [];
          let totalLength = 0;

          responseStream.on('data', (chunk: Buffer) => {
            totalLength += chunk.length;
            if (!checkContentLength(totalLength, maxContentLength)) {
              (responseStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
              reject(
                createError(
                  `Response size ${totalLength} exceeds maxContentLength ${maxContentLength}`,
                  config,
                  'ERR_CONTENT_TOO_LARGE'
                )
              );
              return;
            }
            chunks.push(chunk);
          });

          responseStream.on('error', (err: Error) => {
            reject(createError(err.message, config, 'ERR_NETWORK'));
          });

          responseStream.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (value !== undefined) {
                responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
              }
            }

            let responseData: unknown;
            if (config.responseType === 'arraybuffer') {
              responseData = buffer;
            } else {
              const text = buffer.toString('utf-8');
              if (config.responseType === 'text') {
                responseData = text;
              } else {
                // Default: try JSON, fall back to text
                try {
                  responseData = JSON.parse(text);
                } catch {
                  responseData = text;
                }
              }
            }

            const response: BridgeResponse = {
              data: responseData,
              status: statusCode,
              statusText: res.statusMessage || '',
              headers: responseHeaders,
              config,
            };

            const validateStatus = config.validateStatus || defaultValidateStatus;
            if (validateStatus(statusCode)) {
              resolve(response);
            } else {
              reject(
                createError(
                  `Request failed with status code ${statusCode}`,
                  config,
                  'ERR_BAD_RESPONSE',
                  response
                )
              );
            }
          });
        }
      );

      // Error handler — must be registered before any destroy() calls
      req.on('error', (err: NodeJS.ErrnoException) => {
        reject(createError(err.message, config, err.code || 'ERR_NETWORK'));
      });

      // Timeout
      if (timeout > 0) {
        req.setTimeout(timeout, () => {
          req.destroy();
          reject(
            createError(
              `Timeout of ${timeout}ms exceeded`,
              config,
              'ECONNABORTED'
            )
          );
        });
      }

      // AbortController / signal support
      if (config.signal) {
        const onAbort = () => {
          req.destroy();
          reject(
            createError(
              'Request aborted',
              config,
              'ERR_CANCELED'
            )
          );
        };
        if (config.signal.aborted) {
          onAbort();
          return;
        }
        config.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Write body and send
      if (requestData) {
        req.write(requestData);
      }
      req.end();
    }

    doRequest(requestOptions, parsedURL);
  });
}

function defaultValidateStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
