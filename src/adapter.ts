import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { URL } from 'url';
import { BridgeRequestConfig, BridgeResponse, BridgeError, ProgressEvent } from './types';
import { createError } from './error';
import { validateURL, sanitizeHeaders, checkContentLength, dnsResolveAndValidate, injectRequestId, validateDomain, isSameOrigin, stripSensitiveHeaders, checkHttpsDowngrade, safeJSONParse, checkDecompressionRatio, validateResponseHeaders, normalizeHostname, validateContentLengthIntegrity, getStrictSecurityDefaults, DEFAULT_MAX_RESPONSE_HEADERS, DEFAULT_MAX_RESPONSE_HEADER_SIZE, DEFAULT_MAX_DECOMPRESSION_RATIO } from './security';
import { buildFullURL } from './utils';
import { resolveRetryConfig, shouldRetry, calculateDelay, sleep } from './retry';
import { createTimeline, finalizeTimeline, RequestTimeline } from './timeline';
import { signRequest } from './signing';
import { shouldBypassProxy, createProxyTunnel, buildProxyRequestOptions, ProxyConfig } from './proxy';
import { DNSCache } from './dns-cache';

// ─── Default Config ────────────────────────────────────────────────────────────

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 0; // no timeout
const DEFAULT_MAX_CONTENT_LENGTH = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_BODY_LENGTH = 50 * 1024 * 1024;    // 50 MB
const MAX_PROGRESS_EVENTS = 100; // Maximum number of progress events during upload

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
  const respectRetryAfter = config.respectRetryAfter !== false;

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

      let delay = calculateDelay(retryConfig, attempt);

      // v6.0.0: Respect Retry-After header from server
      if (respectRetryAfter && bridgeError.response?.headers) {
        const retryAfter = bridgeError.response.headers['retry-after'];
        if (retryAfter) {
          const retryAfterMs = parseRetryAfter(retryAfter);
          if (retryAfterMs !== null && retryAfterMs > 0) {
            // Use the larger of calculated delay and Retry-After
            delay = Math.max(delay, retryAfterMs);
            // Cap at maxDelay to prevent absurdly long waits
            delay = Math.min(delay, retryConfig.maxDelay);
          }
        }
      }

      // Fire onRetry hook
      if (config.hooks?.onRetry) {
        config.hooks.onRetry(attempt + 1, bridgeError, delay);
      }

      await sleep(delay, config.signal);
    }
  }

  throw lastError;
}

/**
 * Parses a Retry-After header value into milliseconds.
 * Supports both delay-seconds and HTTP-date formats.
 */
function parseRetryAfter(value: string): number | null {
  // Try as number (seconds)
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && String(seconds) === value.trim()) {
    return seconds * 1000;
  }

  // Try as HTTP-date
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return null;
}

function executeRequest(config: BridgeRequestConfig): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    // v8.0.0: Apply strict security defaults if enabled
    let effectiveConfig = config;
    if (config.strictSecurity) {
      const strictDefaults = getStrictSecurityDefaults();
      effectiveConfig = {
        ...config,
        enforceHttps: config.enforceHttps ?? strictDefaults.enforceHttps,
        dnsProtection: config.dnsProtection ?? strictDefaults.dnsProtection,
        stripSensitiveHeadersOnRedirect: config.stripSensitiveHeadersOnRedirect ?? strictDefaults.stripSensitiveHeadersOnRedirect,
        allowHttpsDowngrade: config.allowHttpsDowngrade ?? strictDefaults.allowHttpsDowngrade,
        allowPrivateNetworks: config.allowPrivateNetworks ?? strictDefaults.allowPrivateNetworks,
        blockHomographAttacks: config.blockHomographAttacks ?? strictDefaults.blockHomographAttacks,
        maxResponseHeaders: config.maxResponseHeaders ?? strictDefaults.maxResponseHeaders,
        maxResponseHeaderSize: config.maxResponseHeaderSize ?? strictDefaults.maxResponseHeaderSize,
        maxDecompressionRatio: config.maxDecompressionRatio ?? strictDefaults.maxDecompressionRatio,
        safeJsonParsing: config.safeJsonParsing ?? strictDefaults.safeJsonParsing,
        validateContentLength: config.validateContentLength ?? strictDefaults.validateContentLength,
        tls: {
          ...config.tls,
          minVersion: config.tls?.minVersion ?? strictDefaults.tlsMinVersion,
        },
      };
    }

    // Fire onRequest hook
    if (effectiveConfig.hooks?.onRequest) {
      effectiveConfig.hooks.onRequest(effectiveConfig);
    }

    // Initialize timeline if requested
    const timeline: RequestTimeline | undefined = effectiveConfig.collectTimeline
      ? createTimeline()
      : undefined;

    // Inject request ID if enabled
    const headersWithId = injectRequestId(effectiveConfig);
    const configWithId = { ...effectiveConfig, headers: headersWithId };

    const fullURL = buildFullURL(configWithId);
    let parsedURL: URL;

    // v8.0.0: IDN homograph attack protection — check the raw URL before URL parser normalizes it
    if (configWithId.blockHomographAttacks) {
      try {
        // Extract hostname from the raw URL string before URL parser converts IDN to punycode
        const rawHostnameMatch = fullURL.match(/^https?:\/\/([^/:?#]+)/i);
        if (rawHostnameMatch) {
          normalizeHostname(rawHostnameMatch[1], true);
        }
      } catch (err) {
        const error = createError((err as Error).message, configWithId, 'ERR_IDN_HOMOGRAPH');
        if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
        reject(error);
        return;
      }
    }

    try {
      parsedURL = validateURL(
        fullURL,
        configWithId.allowPrivateNetworks ?? false,
        configWithId.enforceHttps
      );
    } catch (err) {
      const error = createError((err as Error).message, configWithId, 'ERR_INVALID_URL');
      if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
      reject(error);
      return;
    }

    // v5.0.0: Domain allowlist/blocklist validation
    try {
      validateDomain(
        parsedURL.hostname,
        configWithId.allowedDomains,
        configWithId.blockedDomains
      );
    } catch (err) {
      const error = createError((err as Error).message, configWithId, 'ERR_DOMAIN_BLOCKED');
      if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
      reject(error);
      return;
    }

    const method = (configWithId.method || 'GET').toUpperCase();
    let headers: Record<string, string>;
    try {
      headers = sanitizeHeaders(configWithId.headers);
    } catch (err) {
      const error = createError((err as Error).message, configWithId, 'ERR_HEADER_INJECTION');
      if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
      reject(error);
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
        const error = createError(
          `Request body size ${bodyLen} exceeds maxBodyLength ${maxBodyLength}`,
          configWithId,
          'ERR_BODY_TOO_LARGE'
        );
        if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
        reject(error);
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

    // v6.0.0: Idempotency key injection
    if (configWithId.idempotencyKey) {
      const idempotencyValue = typeof configWithId.idempotencyKey === 'string'
        ? configWithId.idempotencyKey
        : crypto.randomUUID();
      headers['Idempotency-Key'] = idempotencyValue;
    }

    // v6.0.0: HMAC request signing
    if (configWithId.requestSigning) {
      const signingHeaders = signRequest(
        configWithId.requestSigning,
        method,
        fullURL,
        headers,
        requestData
      );
      for (const [key, value] of Object.entries(signingHeaders)) {
        headers[key] = value;
      }
    }

    // Basic auth
    let auth: string | undefined;
    if (configWithId.auth) {
      auth = `${configWithId.auth.username}:${configWithId.auth.password}`;
    }

    // Early abort check — before creating any request
    if (configWithId.signal && configWithId.signal.aborted) {
      const error = createError('Request aborted', configWithId, 'ERR_CANCELED');
      if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
      reject(error);
      return;
    }

    // DNS protection — resolve hostname and validate IP before connecting
    const dnsProtection = configWithId.dnsProtection ?? false;
    const allowPrivate = configWithId.allowPrivateNetworks ?? false;

    const startRequest = (resolvedIP?: string) => {
      const isHttps = parsedURL.protocol === 'https:';
      const transport = isHttps ? https : http;

      // v7.0.0: Proxy support
      const proxyConfig = configWithId.proxy;
      const useProxy = proxyConfig && typeof proxyConfig === 'object' &&
        !shouldBypassProxy(parsedURL.hostname, proxyConfig.noProxy);

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

            // Timeline: first byte
            if (timeline) {
              timeline.firstByte = Date.now() - timeline.startTime;
            }

            // Certificate pinning verification
            if (configWithId.tls?.certFingerprint && reqURL.protocol === 'https:') {
              const socket = res.socket as tls.TLSSocket;
              if (socket && typeof socket.getPeerCertificate === 'function') {
                const cert = socket.getPeerCertificate();
                if (cert && cert.fingerprint256) {
                  const normalizedExpected = configWithId.tls.certFingerprint.toUpperCase().replace(/:/g, '');
                  const normalizedActual = cert.fingerprint256.toUpperCase().replace(/:/g, '');
                  if (normalizedExpected !== normalizedActual) {
                    const error = createError(
                      `Certificate fingerprint mismatch. Expected: ${configWithId.tls.certFingerprint}, Got: ${cert.fingerprint256}`,
                      configWithId,
                      'ERR_CERT_FINGERPRINT_MISMATCH'
                    );
                    if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                    reject(error);
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
                const error = createError(
                  `Maximum redirects (${maxRedirects}) exceeded`,
                  configWithId,
                  'ERR_MAX_REDIRECTS'
                );
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
                req.destroy();
                return;
              }

              let redirectURL: URL;
              try {
                redirectURL = new URL(res.headers.location, reqURL);
              } catch {
                const error = createError(
                  `Invalid redirect URL: ${res.headers.location}`,
                  configWithId,
                  'ERR_INVALID_URL'
                );
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
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
                const error = createError((err as Error).message, configWithId, 'ERR_INVALID_URL');
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
                req.destroy();
                return;
              }

              // v5.0.0: Validate redirect domain against allowlist/blocklist
              try {
                validateDomain(
                  redirectURL.hostname,
                  configWithId.allowedDomains,
                  configWithId.blockedDomains
                );
              } catch (err) {
                const error = createError((err as Error).message, configWithId, 'ERR_DOMAIN_BLOCKED');
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
                req.destroy();
                return;
              }

              // v5.0.0: HTTPS downgrade protection on redirects
              try {
                checkHttpsDowngrade(
                  reqURL,
                  redirectURL,
                  configWithId.allowHttpsDowngrade ?? false
                );
              } catch (err) {
                const error = createError((err as Error).message, configWithId, 'ERR_HTTPS_DOWNGRADE');
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
                req.destroy();
                return;
              }

              const redirectOptions: http.RequestOptions = {
                ...reqOptions,
                hostname: redirectURL.hostname,
                port: redirectURL.port || (redirectURL.protocol === 'https:' ? 443 : 80),
                path: redirectURL.pathname + redirectURL.search,
              };

              // v5.0.0: Strip sensitive headers on cross-origin redirects
              const shouldStripSensitive = configWithId.stripSensitiveHeadersOnRedirect !== false;
              if (shouldStripSensitive && !isSameOrigin(reqURL, redirectURL)) {
                redirectOptions.headers = stripSensitiveHeaders(
                  redirectOptions.headers as Record<string, string>
                );
              }

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
                ...(timeline ? { timeline: finalizeTimeline(timeline) } : {}),
              };

              const validateStatus = configWithId.validateStatus || defaultValidateStatus;
              if (validateStatus(statusCode)) {
                if (effectiveConfig.hooks?.onResponse) effectiveConfig.hooks.onResponse(response);
                resolve(response);
              } else {
                const error = createError(
                  `Request failed with status code ${statusCode}`,
                  configWithId,
                  'ERR_BAD_RESPONSE',
                  response
                );
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
              }
              return;
            }

            // Buffer the response body with progress tracking
            const chunks: Buffer[] = [];
            let totalLength = 0;
            let responseTimedOut = false;
            const downloadStartTime = Date.now();
            const contentLengthHeader = res.headers['content-length'];
            const expectedTotal = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

            // Response timeout (for body download)
            let responseTimer: ReturnType<typeof setTimeout> | undefined;
            if (responseTimeout && responseTimeout > 0) {
              responseTimer = setTimeout(() => {
                responseTimedOut = true;
                (responseStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
                const error = createError(
                  `Response timeout of ${responseTimeout}ms exceeded`,
                  configWithId,
                  'ERR_RESPONSE_TIMEOUT'
                );
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
              }, responseTimeout);
            }

            responseStream.on('data', (chunk: Buffer) => {
              if (responseTimedOut) return;
              totalLength += chunk.length;
              if (!checkContentLength(totalLength, maxContentLength)) {
                if (responseTimer) clearTimeout(responseTimer);
                (responseStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
                const error = createError(
                  `Response size ${totalLength} exceeds maxContentLength ${maxContentLength}`,
                  configWithId,
                  'ERR_CONTENT_TOO_LARGE'
                );
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
                return;
              }
              chunks.push(chunk);

              // Fire download progress callback
              if (configWithId.onDownloadProgress) {
                const elapsed = Date.now() - downloadStartTime;
                const rate = elapsed > 0 ? (totalLength / elapsed) * 1000 : 0;
                const progress = expectedTotal > 0
                  ? Math.round((totalLength / expectedTotal) * 100)
                  : -1;
                const estimated = expectedTotal > 0 && rate > 0
                  ? Math.round(((expectedTotal - totalLength) / rate) * 1000)
                  : -1;
                const event: ProgressEvent = {
                  loaded: totalLength,
                  total: expectedTotal,
                  progress,
                  rate,
                  estimated,
                };
                configWithId.onDownloadProgress(event);
              }
            });

            responseStream.on('error', (err: Error) => {
              if (responseTimedOut) return;
              if (responseTimer) clearTimeout(responseTimer);
              const error = createError(err.message, configWithId, 'ERR_NETWORK');
              if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
              reject(error);
            });

            responseStream.on('end', () => {
              if (responseTimedOut) return;
              if (responseTimer) clearTimeout(responseTimer);

              // Timeline: content download
              if (timeline) {
                timeline.contentDownload = Date.now() - downloadStartTime;
              }

              const buffer = Buffer.concat(chunks);

              // v8.0.0: Decompression bomb protection
              if (encoding && configWithId.maxDecompressionRatio !== undefined) {
                const compressedLength = parseInt(res.headers['content-length'] || '0', 10);
                if (compressedLength > 0) {
                  const maxRatio = configWithId.maxDecompressionRatio;
                  if (!checkDecompressionRatio(compressedLength, buffer.length, maxRatio)) {
                    const error = createError(
                      `Decompression ratio ${Math.round(buffer.length / compressedLength)}:1 exceeds maximum allowed ${maxRatio}:1. ` +
                      'This may indicate a decompression bomb attack.',
                      configWithId,
                      'ERR_DECOMPRESSION_BOMB'
                    );
                    if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                    reject(error);
                    return;
                  }
                }
              }

              // v8.0.0: Content-Length integrity validation
              if (configWithId.validateContentLength) {
                const declaredLength = parseInt(res.headers['content-length'] || '-1', 10);
                if (!validateContentLengthIntegrity(declaredLength, totalLength)) {
                  const error = createError(
                    `Content-Length mismatch: header declared ${declaredLength} bytes but received ${totalLength} bytes. ` +
                    'This may indicate response truncation or smuggling.',
                    configWithId,
                    'ERR_CONTENT_LENGTH_MISMATCH'
                  );
                  if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                  reject(error);
                  return;
                }
              }

              // v6.0.0: Response integrity verification (SHA-256)
              if (configWithId.expectedHash) {
                const actualHash = crypto
                  .createHash('sha256')
                  .update(buffer)
                  .digest('hex');
                const normalizedExpected = configWithId.expectedHash.toLowerCase().replace(/:/g, '');
                const normalizedActual = actualHash.toLowerCase();
                if (normalizedExpected !== normalizedActual) {
                  const error = createError(
                    `Response integrity check failed. Expected hash: ${configWithId.expectedHash}, Got: ${actualHash}`,
                    configWithId,
                    'ERR_INTEGRITY_CHECK_FAILED'
                  );
                  if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                  reject(error);
                  return;
                }
              }

              // v6.0.0: Content-Type validation
              if (configWithId.expectedContentType) {
                const actualContentType = res.headers['content-type'] || '';
                const expected = configWithId.expectedContentType.toLowerCase();
                const actual = actualContentType.toLowerCase();
                if (!actual.startsWith(expected)) {
                  const error = createError(
                    `Response Content-Type mismatch. Expected: ${configWithId.expectedContentType}, Got: ${actualContentType}`,
                    configWithId,
                    'ERR_CONTENT_TYPE_MISMATCH'
                  );
                  if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                  reject(error);
                  return;
                }
              }

              const responseHeaders: Record<string, string> = {};
              for (const [key, value] of Object.entries(res.headers)) {
                if (value !== undefined) {
                  responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
                }
              }

              // v8.0.0: Response header flood protection
              if (configWithId.maxResponseHeaders || configWithId.maxResponseHeaderSize) {
                try {
                  validateResponseHeaders(
                    responseHeaders,
                    configWithId.maxResponseHeaders ?? DEFAULT_MAX_RESPONSE_HEADERS,
                    configWithId.maxResponseHeaderSize ?? DEFAULT_MAX_RESPONSE_HEADER_SIZE
                  );
                } catch (err) {
                  const error = createError(
                    (err as Error).message,
                    configWithId,
                    'ERR_RESPONSE_HEADER_FLOOD'
                  );
                  if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                  reject(error);
                  return;
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
                  // v8.0.0: Use safe JSON parsing to prevent prototype pollution
                  try {
                    responseData = configWithId.safeJsonParsing
                      ? safeJSONParse(text)
                      : JSON.parse(text);
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
                ...(timeline ? { timeline: finalizeTimeline(timeline) } : {}),
              };

              const validateStatus = configWithId.validateStatus || defaultValidateStatus;
              if (validateStatus(statusCode)) {
                if (effectiveConfig.hooks?.onResponse) effectiveConfig.hooks.onResponse(response);
                resolve(response);
              } else {
                const error = createError(
                  `Request failed with status code ${statusCode}`,
                  configWithId,
                  'ERR_BAD_RESPONSE',
                  response
                );
                if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
                reject(error);
              }
            });
          }
        );

        // Track socket events for timeline
        if (timeline) {
          req.on('socket', (socket) => {
            const socketStartTime = Date.now();
            socket.once('lookup', () => {
              timeline.dnsLookup = Date.now() - socketStartTime;
            });
            socket.once('connect', () => {
              timeline.tcpConnect = Date.now() - socketStartTime;
            });
            socket.once('secureConnect', () => {
              timeline.tlsHandshake = Date.now() - socketStartTime - timeline.tcpConnect;
            });
          });
        }

        // Error handler — must be registered before any destroy() calls
        req.on('error', (err: NodeJS.ErrnoException) => {
          const error = createError(err.message, configWithId, err.code || 'ERR_NETWORK');
          if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
          reject(error);
        });

        // Timeout
        if (timeout > 0) {
          req.setTimeout(timeout, () => {
            req.destroy();
            const error = createError(
              `Timeout of ${timeout}ms exceeded`,
              configWithId,
              'ECONNABORTED'
            );
            if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
            reject(error);
          });
        }

        // AbortController / signal support
        if (configWithId.signal) {
          const onAbort = () => {
            req.destroy();
            const error = createError(
              'Request aborted',
              configWithId,
              'ERR_CANCELED'
            );
            if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
            reject(error);
          };
          if (configWithId.signal.aborted) {
            onAbort();
            return;
          }
          configWithId.signal.addEventListener('abort', onAbort, { once: true });
        }

        // Write body with upload progress tracking
        if (requestData) {
          if (configWithId.onUploadProgress) {
            const dataBuffer = typeof requestData === 'string'
              ? Buffer.from(requestData)
              : requestData;
            const totalSize = dataBuffer.length;
            const chunkSize = Math.max(1024, Math.ceil(totalSize / MAX_PROGRESS_EVENTS));
            let bytesSent = 0;
            const uploadStartTime = Date.now();

            let offset = 0;
            const writeChunk = () => {
              while (offset < totalSize) {
                const end = Math.min(offset + chunkSize, totalSize);
                const chunk = dataBuffer.subarray(offset, end);
                offset = end;
                bytesSent += chunk.length;

                const elapsed = Date.now() - uploadStartTime;
                const rate = elapsed > 0 ? (bytesSent / elapsed) * 1000 : 0;
                const progress = Math.round((bytesSent / totalSize) * 100);
                const estimated = rate > 0
                  ? Math.round(((totalSize - bytesSent) / rate) * 1000)
                  : -1;

                configWithId.onUploadProgress!({
                  loaded: bytesSent,
                  total: totalSize,
                  progress,
                  rate,
                  estimated,
                });

                const canContinue = req.write(chunk);
                if (!canContinue) {
                  req.once('drain', writeChunk);
                  return;
                }
              }
              req.end();
            };
            writeChunk();
          } else {
            req.write(requestData);
            req.end();
          }
        } else {
          req.end();
        }
      }

      // v7.0.0: If using a proxy, set up tunneling for HTTPS or direct proxying for HTTP
      if (useProxy && proxyConfig) {
        if (isHttps) {
          // HTTPS through proxy: use CONNECT tunneling
          const targetHost = parsedURL.hostname;
          const targetPort = parseInt(parsedURL.port || '443', 10);
          createProxyTunnel(proxyConfig, targetHost, targetPort)
            .then((tunnelSocket) => {
              // Use the tunnel socket as the connection
              (requestOptions as Record<string, unknown>).socket = tunnelSocket;
              requestOptions.hostname = targetHost;
              doRequest(requestOptions, parsedURL);
            })
            .catch((err) => {
              const error = createError(
                (err as Error).message,
                configWithId,
                'ERR_PROXY_CONNECT_FAILED'
              );
              if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
              reject(error);
            });
        } else {
          // HTTP through proxy: send full URL as path
          const proxyOptions = buildProxyRequestOptions(
            proxyConfig,
            fullURL,
            method,
            requestOptions.headers as Record<string, string>
          );
          doRequest(proxyOptions, parsedURL);
        }
      } else {
        doRequest(requestOptions, parsedURL);
      }
    };

    // Execute with optional DNS protection
    if (dnsProtection && !parsedURL.hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      dnsResolveAndValidate(parsedURL.hostname, allowPrivate)
        .then((resolvedIP) => {
          if (timeline) {
            timeline.dnsLookup = Date.now() - timeline.startTime;
          }
          startRequest(resolvedIP);
        })
        .catch((err) => {
          const error = createError((err as Error).message, configWithId, 'ERR_DNS_RESOLUTION');
          if (effectiveConfig.hooks?.onError) effectiveConfig.hooks.onError(error);
          reject(error);
        });
    } else {
      startRequest();
    }
  });
}

function defaultValidateStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
