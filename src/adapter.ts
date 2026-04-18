import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { URL } from 'url';
import { BridgeRequestConfig, BridgeResponse, BridgeError } from './types';
import { createError } from './error';
import { validateURL, sanitizeHeaders, checkContentLength, dnsResolveAndValidate, injectRequestId } from './security';
import { buildFullURL } from './utils';
import { resolveRetryConfig, shouldRetry, calculateDelay, sleep } from './retry';

// ─── Default Config ────────────────────────────────────────────────────────────

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 0; // no timeout
const DEFAULT_MAX_CONTENT_LENGTH = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_BODY_LENGTH = 50 * 1024 * 1024;    // 50 MB

// ─── Adapter ───────────────────────────────────────────────────────────────────

export function httpAdapter(config: BridgeRequestConfig): Promise<BridgeResponse> {
  const retryConfig = resolveRetryConfig(config);

  if (retryConfig) {
    return executeWithRetry(config, retryConfig);
  }
  return executeRequest(config);
}

async function executeWithRetry(
  config: BridgeRequestConfig,
  retryConfig: ReturnType<typeof resolveRetryConfig> & object
): Promise<BridgeResponse> {
  let lastError: BridgeError | undefined;

  for (let attempt = 0; attempt <= retryConfig.retries; attempt++) {
    try {
      return await executeRequest(config);
    } catch (err) {
      const bridgeError = err as BridgeError;
      lastError = bridgeError;

      const method = (config.method || 'GET').toUpperCase();
      if (!shouldRetry(bridgeError, retryConfig, attempt, method)) {
        throw bridgeError;
      }

      // Check if request was aborted — don't retry if so
      if (config.signal?.aborted) {
        throw bridgeError;
      }

      const delay = calculateDelay(retryConfig, attempt);
      await sleep(delay, config.signal);
    }
  }

  throw lastError;
}

function executeRequest(config: BridgeRequestConfig): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    // Inject request ID if enabled
    const headersWithId = injectRequestId(config);
    const configWithId = { ...config, headers: headersWithId };

    const fullURL = buildFullURL(configWithId);
    let parsedURL: URL;

    try {
      parsedURL = validateURL(
        fullURL,
        configWithId.allowPrivateNetworks ?? false,
        configWithId.enforceHttps
      );
    } catch (err) {
      reject(createError((err as Error).message, configWithId, 'ERR_INVALID_URL'));
      return;
    }

    const method = (configWithId.method || 'GET').toUpperCase();
    let headers: Record<string, string>;
    try {
      headers = sanitizeHeaders(configWithId.headers);
    } catch (err) {
      reject(createError((err as Error).message, configWithId, 'ERR_HEADER_INJECTION'));
      return;
    }
    const timeout = configWithId.timeout ?? DEFAULT_TIMEOUT;
    const responseTimeout = configWithId.responseTimeout;
    const maxContentLength = configWithId.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    const maxBodyLength = configWithId.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;
    const maxRedirects = configWithId.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const decompress = configWithId.decompress !== false;

    // Apply request transformers
    let requestBody = configWithId.data;
    if (configWithId.transformRequest && configWithId.data !== undefined && configWithId.data !== null) {
      for (const transformer of configWithId.transformRequest) {
        requestBody = transformer(requestBody, headers);
      }
    }

    // Prepare request body
    let requestData: Buffer | string | undefined;
    if (requestBody !== undefined && requestBody !== null) {
      if (Buffer.isBuffer(requestBody)) {
        requestData = requestBody;
      } else if (typeof requestBody === 'string') {
        requestData = requestBody;
      } else {
        // Auto-serialize JSON
        requestData = JSON.stringify(requestBody);
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
            configWithId,
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
    if (configWithId.auth) {
      auth = `${configWithId.auth.username}:${configWithId.auth.password}`;
    }

    // Early abort check — before creating any request
    if (configWithId.signal && configWithId.signal.aborted) {
      reject(createError('Request aborted', configWithId, 'ERR_CANCELED'));
      return;
    }

    // DNS protection — resolve hostname and validate IP before connecting
    const dnsProtection = configWithId.dnsProtection ?? false;
    const allowPrivate = configWithId.allowPrivateNetworks ?? false;

    const startRequest = (resolvedIP?: string) => {
      const isHttps = parsedURL.protocol === 'https:';
      const transport = isHttps ? https : http;

      const requestOptions: http.RequestOptions & https.RequestOptions = {
        hostname: resolvedIP || parsedURL.hostname,
        port: parsedURL.port || (isHttps ? 443 : 80),
        path: parsedURL.pathname + parsedURL.search,
        method,
        headers: {
          ...headers,
          // Ensure Host header is correct even when connecting via resolved IP
          ...(resolvedIP ? { Host: parsedURL.hostname + (parsedURL.port ? `:${parsedURL.port}` : '') } : {}),
        },
        auth,
      };

      if (configWithId.maxHeaderSize) {
        requestOptions.maxHeaderSize = configWithId.maxHeaderSize;
      }

      // TLS options
      if (isHttps && configWithId.tls) {
        const tlsConfig = configWithId.tls;
        if (tlsConfig.rejectUnauthorized !== undefined) {
          requestOptions.rejectUnauthorized = tlsConfig.rejectUnauthorized;
        }
        if (tlsConfig.ca) {
          requestOptions.ca = tlsConfig.ca;
        }
        if (tlsConfig.cert) {
          requestOptions.cert = tlsConfig.cert;
        }
        if (tlsConfig.key) {
          requestOptions.key = tlsConfig.key;
        }
        if (tlsConfig.pfx) {
          requestOptions.pfx = tlsConfig.pfx;
        }
        if (tlsConfig.passphrase) {
          requestOptions.passphrase = tlsConfig.passphrase;
        }
        if (tlsConfig.minVersion) {
          requestOptions.minVersion = tlsConfig.minVersion;
        }
        if (tlsConfig.ciphers) {
          requestOptions.ciphers = tlsConfig.ciphers;
        }
      }

      let redirectCount = 0;

      function doRequest(reqOptions: http.RequestOptions, reqURL: URL): void {
        const reqTransport = (reqURL.protocol === 'https:' ? https : http);
        const req = reqTransport.request(
          reqOptions,
          (res: http.IncomingMessage) => {
            const statusCode = res.statusCode || 0;

            // Certificate pinning verification
            if (configWithId.tls?.certFingerprint && reqURL.protocol === 'https:') {
              const socket = res.socket as tls.TLSSocket;
              if (socket && typeof socket.getPeerCertificate === 'function') {
                const cert = socket.getPeerCertificate();
                if (cert && cert.fingerprint256) {
                  const normalizedExpected = configWithId.tls.certFingerprint.toUpperCase().replace(/:/g, '');
                  const normalizedActual = cert.fingerprint256.toUpperCase().replace(/:/g, '');
                  if (normalizedExpected !== normalizedActual) {
                    reject(
                      createError(
                        `Certificate fingerprint mismatch. Expected: ${configWithId.tls.certFingerprint}, Got: ${cert.fingerprint256}`,
                        configWithId,
                        'ERR_CERT_FINGERPRINT_MISMATCH'
                      )
                    );
                    req.destroy();
                    return;
                  }
                }
              }
            }

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
                    configWithId,
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
                    configWithId,
                    'ERR_INVALID_URL'
                  )
                );
                req.destroy();
                return;
              }

              // Validate redirect URL
              try {
                validateURL(
                  redirectURL.href,
                  configWithId.allowPrivateNetworks ?? false,
                  configWithId.enforceHttps
                );
              } catch (err) {
                reject(createError((err as Error).message, configWithId, 'ERR_INVALID_URL'));
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
            if (configWithId.responseType === 'stream') {
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
                config: configWithId,
              };

              const validateStatus = configWithId.validateStatus || defaultValidateStatus;
              if (validateStatus(statusCode)) {
                resolve(response);
              } else {
                reject(
                  createError(
                    `Request failed with status code ${statusCode}`,
                    configWithId,
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
            let responseTimedOut = false;

            // Response timeout (for body download)
            let responseTimer: ReturnType<typeof setTimeout> | undefined;
            if (responseTimeout && responseTimeout > 0) {
              responseTimer = setTimeout(() => {
                responseTimedOut = true;
                (responseStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
                reject(
                  createError(
                    `Response timeout of ${responseTimeout}ms exceeded`,
                    configWithId,
                    'ERR_RESPONSE_TIMEOUT'
                  )
                );
              }, responseTimeout);
            }

            responseStream.on('data', (chunk: Buffer) => {
              if (responseTimedOut) return;
              totalLength += chunk.length;
              if (!checkContentLength(totalLength, maxContentLength)) {
                if (responseTimer) clearTimeout(responseTimer);
                (responseStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
                reject(
                  createError(
                    `Response size ${totalLength} exceeds maxContentLength ${maxContentLength}`,
                    configWithId,
                    'ERR_CONTENT_TOO_LARGE'
                  )
                );
                return;
              }
              chunks.push(chunk);
            });

            responseStream.on('error', (err: Error) => {
              if (responseTimedOut) return;
              if (responseTimer) clearTimeout(responseTimer);
              reject(createError(err.message, configWithId, 'ERR_NETWORK'));
            });

            responseStream.on('end', () => {
              if (responseTimedOut) return;
              if (responseTimer) clearTimeout(responseTimer);

              const buffer = Buffer.concat(chunks);
              const responseHeaders: Record<string, string> = {};
              for (const [key, value] of Object.entries(res.headers)) {
                if (value !== undefined) {
                  responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
                }
              }

              let responseData: unknown;
              if (configWithId.responseType === 'arraybuffer') {
                responseData = buffer;
              } else {
                const text = buffer.toString('utf-8');
                if (configWithId.responseType === 'text') {
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

              // Apply response transformers
              if (configWithId.transformResponse) {
                for (const transformer of configWithId.transformResponse) {
                  responseData = transformer(responseData);
                }
              }

              const response: BridgeResponse = {
                data: responseData,
                status: statusCode,
                statusText: res.statusMessage || '',
                headers: responseHeaders,
                config: configWithId,
              };

              const validateStatus = configWithId.validateStatus || defaultValidateStatus;
              if (validateStatus(statusCode)) {
                resolve(response);
              } else {
                reject(
                  createError(
                    `Request failed with status code ${statusCode}`,
                    configWithId,
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
          reject(createError(err.message, configWithId, err.code || 'ERR_NETWORK'));
        });

        // Timeout
        if (timeout > 0) {
          req.setTimeout(timeout, () => {
            req.destroy();
            reject(
              createError(
                `Timeout of ${timeout}ms exceeded`,
                configWithId,
                'ECONNABORTED'
              )
            );
          });
        }

        // AbortController / signal support
        if (configWithId.signal) {
          const onAbort = () => {
            req.destroy();
            reject(
              createError(
                'Request aborted',
                configWithId,
                'ERR_CANCELED'
              )
            );
          };
          if (configWithId.signal.aborted) {
            onAbort();
            return;
          }
          configWithId.signal.addEventListener('abort', onAbort, { once: true });
        }

        // Write body and send
        if (requestData) {
          req.write(requestData);
        }
        req.end();
      }

      doRequest(requestOptions, parsedURL);
    };

    // Execute with optional DNS protection
    if (dnsProtection && !parsedURL.hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      dnsResolveAndValidate(parsedURL.hostname, allowPrivate)
        .then((resolvedIP) => startRequest(resolvedIP))
        .catch((err) => reject(createError((err as Error).message, configWithId, 'ERR_DNS_RESOLUTION')));
    } else {
      startRequest();
    }
  });
}

function defaultValidateStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
