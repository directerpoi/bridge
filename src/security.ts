import * as url from 'url';
import * as net from 'net';
import * as dns from 'dns';
import * as crypto from 'crypto';
import * as punycode from 'punycode';
import { BridgeRequestConfig } from './types';

// ─── Private / Reserved IP Ranges ──────────────────────────────────────────────

const PRIVATE_IPV4_RANGES = [
  /^127\./,                        // 127.0.0.0/8 loopback
  /^10\./,                         // 10.0.0.0/8 private
  /^172\.(1[6-9]|2\d|3[01])\./,   // 172.16.0.0/12 private
  /^192\.168\./,                   // 192.168.0.0/16 private
  /^0\./,                          // 0.0.0.0/8 current network
  /^169\.254\./,                   // 169.254.0.0/16 link-local
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,  // 100.64.0.0/10 shared address space
  /^198\.1[89]\./,                 // 198.18.0.0/15 benchmark testing
  /^192\.0\.0\./,                  // 192.0.0.0/24 IANA special purpose
  /^192\.0\.2\./,                  // 192.0.2.0/24 TEST-NET-1
  /^198\.51\.100\./,               // 198.51.100.0/24 TEST-NET-2
  /^203\.0\.113\./,                // 203.0.113.0/24 TEST-NET-3
  /^(22[4-9]|23\d|24\d|25[0-5])\./, // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
];

const PRIVATE_IPV6_PREFIXES = [
  '::1',         // loopback
  'fc',          // unique local
  'fd',          // unique local
  'fe80:',       // link-local
  '::ffff:127.', // IPv4-mapped loopback
  '::ffff:10.',  // IPv4-mapped private
  '::ffff:172.', // IPv4-mapped private (simplified check)
  '::ffff:192.168.', // IPv4-mapped private
  '::ffff:0.',   // IPv4-mapped current network
  '::ffff:169.254.', // IPv4-mapped link-local
  'ff',          // multicast
  '::',          // unspecified (when followed by nothing or non-1)
];

/**
 * Returns true if the given IP address is in a private/reserved range.
 */
function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return PRIVATE_IPV4_RANGES.some((re) => re.test(ip));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return PRIVATE_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }
  return false;
}

// ─── Dangerous Headers ─────────────────────────────────────────────────────────

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',            // should be set by the library only
  'connection',      // managed by Node.js
  'transfer-encoding', // managed by Node.js
  'upgrade',         // prevent protocol switching attacks
  'proxy-authorization', // prevent proxy auth injection
  'te',              // managed by Node.js
]);

// ─── Header Injection Prevention ───────────────────────────────────────────────

const HEADER_INJECTION_RE = /[\r\n\x00]/;

/**
 * Validates that a header key and value do not contain injection characters.
 * Throws if header injection is detected.
 */
function validateHeader(key: string, value: string): void {
  if (HEADER_INJECTION_RE.test(key)) {
    throw new Error(`Header injection detected in header name: "${key}"`);
  }
  if (HEADER_INJECTION_RE.test(value)) {
    throw new Error(`Header injection detected in header value for "${key}"`);
  }
}

// ─── Hostname Validation ───────────────────────────────────────────────────────

const UNSAFE_HOSTNAME_RE = /[\s<>{}|\\^`]/;

/**
 * Validates that a hostname does not contain unsafe characters.
 */
function validateHostname(hostname: string): void {
  if (!hostname) {
    throw new Error('URL hostname is empty');
  }
  if (UNSAFE_HOSTNAME_RE.test(hostname)) {
    throw new Error(`Hostname contains unsafe characters: "${hostname}"`);
  }
  // Block excessively long hostnames (max 253 chars per RFC 1035)
  if (hostname.length > 253) {
    throw new Error(`Hostname exceeds maximum length of 253 characters`);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates a URL for safety. Throws on:
 *  - Non http/https protocols
 *  - Hostname resolving to private IPs (when allowPrivateNetworks is false)
 *  - HTTPS enforcement violations
 *  - Unsafe hostname characters
 *  - Header injection in URL credentials
 */
export function validateURL(
  target: string,
  allowPrivateNetworks: boolean,
  enforceHttps?: boolean
): url.URL {
  const parsed = new url.URL(target);

  // Only allow http and https protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported protocol "${parsed.protocol}". Only http: and https: are allowed.`
    );
  }

  // HTTPS enforcement
  if (enforceHttps && parsed.protocol !== 'https:') {
    throw new Error(
      'HTTPS is enforced. Set enforceHttps: false to allow HTTP requests.'
    );
  }

  // Validate hostname
  validateHostname(parsed.hostname);

  // Block userinfo in URL (potential credential leak / request smuggling)
  if (parsed.username || parsed.password) {
    throw new Error(
      'URL contains embedded credentials. Use the "auth" config option instead.'
    );
  }

  // SSRF protection: block requests to private IPs unless explicitly allowed
  if (!allowPrivateNetworks) {
    const hostname = parsed.hostname;

    // Check if hostname is an IP literal
    if (net.isIP(hostname)) {
      if (isPrivateIP(hostname)) {
        throw new Error(
          `Request to private network address "${hostname}" is blocked. ` +
          'Set allowPrivateNetworks: true to bypass this check.'
        );
      }
    }
  }

  return parsed;
}

/**
 * Performs DNS resolution and validates the resolved IP addresses.
 * This provides protection against DNS rebinding attacks and SSRF via DNS.
 * Returns the first resolved address.
 */
export function dnsResolveAndValidate(
  hostname: string,
  allowPrivateNetworks: boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    // If hostname is already an IP, skip DNS resolution
    if (net.isIP(hostname)) {
      if (!allowPrivateNetworks && isPrivateIP(hostname)) {
        reject(new Error(
          `Request to private network address "${hostname}" is blocked. ` +
          'Set allowPrivateNetworks: true to bypass this check.'
        ));
      } else {
        resolve(hostname);
      }
      return;
    }

    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        reject(new Error(`DNS resolution failed for "${hostname}": ${err.message}`));
        return;
      }

      if (!addresses || addresses.length === 0) {
        reject(new Error(`DNS resolution returned no addresses for "${hostname}"`));
        return;
      }

      if (!allowPrivateNetworks) {
        for (const addr of addresses) {
          const ip = typeof addr === 'string' ? addr : addr.address;
          if (isPrivateIP(ip)) {
            reject(new Error(
              `DNS resolution for "${hostname}" returned private network address "${ip}". ` +
              'This may indicate a DNS rebinding attack. ' +
              'Set allowPrivateNetworks: true to bypass this check.'
            ));
            return;
          }
        }
      }

      const firstAddr = addresses[0];
      resolve(typeof firstAddr === 'string' ? firstAddr : firstAddr.address);
    });
  });
}

/**
 * Sanitizes headers: removes forbidden headers, prevents header injection,
 * and ensures values are strings.
 */
export function sanitizeHeaders(
  headers: Record<string, string | number | boolean> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) continue;

    const strValue = String(value);
    // Validate for header injection attacks
    validateHeader(key, strValue);

    out[key] = strValue;
  }
  return out;
}

/**
 * Enforces a maximum content length. Returns true if the length is within limit.
 */
export function checkContentLength(
  length: number,
  maxContentLength: number | undefined
): boolean {
  if (maxContentLength !== undefined && maxContentLength >= 0 && length > maxContentLength) {
    return false;
  }
  return true;
}

/**
 * Generates a cryptographically random request ID (UUID v4 format).
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Injects a request ID into the config headers.
 * If requestId is a string, uses that value. If true, generates a UUID.
 */
export function injectRequestId(config: BridgeRequestConfig): Record<string, string | number | boolean> {
  const headers = { ...(config.headers || {}) };

  if (config.requestId) {
    const id = typeof config.requestId === 'string'
      ? config.requestId
      : generateRequestId();
    headers['X-Request-ID'] = id;
  }

  return headers;
}

// ─── v5.0.0 Security Features ─────────────────────────────────────────────────

/** Headers considered sensitive that should be stripped on cross-origin redirects */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
]);

/**
 * Matches a hostname against a domain pattern.
 * Supports exact match and wildcard subdomain patterns (e.g. '*.example.com').
 */
function matchesDomainPattern(hostname: string, pattern: string): boolean {
  const lowerHost = hostname.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  if (lowerPattern.startsWith('*.')) {
    const baseDomain = lowerPattern.slice(2);
    // Match the base domain itself or any subdomain
    return lowerHost === baseDomain || lowerHost.endsWith('.' + baseDomain);
  }

  return lowerHost === lowerPattern;
}

/**
 * Validates a hostname against domain allowlist and blocklist.
 * Throws if the hostname is not in the allowlist (when set) or is in the blocklist.
 */
export function validateDomain(
  hostname: string,
  allowedDomains?: string[],
  blockedDomains?: string[]
): void {
  if (blockedDomains && blockedDomains.length > 0) {
    for (const pattern of blockedDomains) {
      if (matchesDomainPattern(hostname, pattern)) {
        throw new Error(
          `Request to domain "${hostname}" is blocked by the domain blocklist.`
        );
      }
    }
  }

  if (allowedDomains && allowedDomains.length > 0) {
    const isAllowed = allowedDomains.some((pattern) =>
      matchesDomainPattern(hostname, pattern)
    );
    if (!isAllowed) {
      throw new Error(
        `Request to domain "${hostname}" is not in the domain allowlist.`
      );
    }
  }
}

/**
 * Checks whether two URLs have the same origin (protocol + hostname + port).
 */
export function isSameOrigin(from: url.URL, to: url.URL): boolean {
  return (
    from.protocol === to.protocol &&
    from.hostname === to.hostname &&
    from.port === to.port
  );
}

/**
 * Strips sensitive headers (Authorization, Cookie, Proxy-Authorization) from a headers
 * object. Used when following cross-origin redirects to prevent credential leakage.
 * Returns a new object without the sensitive headers.
 */
export function stripSensitiveHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Checks for HTTPS to HTTP protocol downgrade in a redirect.
 * Throws if the redirect would downgrade from HTTPS to HTTP and downgrade is not allowed.
 */
export function checkHttpsDowngrade(
  fromURL: url.URL,
  toURL: url.URL,
  allowDowngrade: boolean
): void {
  if (!allowDowngrade && fromURL.protocol === 'https:' && toURL.protocol === 'http:') {
    throw new Error(
      'Redirect from HTTPS to HTTP is blocked (protocol downgrade). ' +
      'Set allowHttpsDowngrade: true to allow this.'
    );
  }
}

// ─── v8.0.0 Security Features ─────────────────────────────────────────────────

// ─── Prototype Pollution Protection ────────────────────────────────────────────

/**
 * Dangerous property names that can be used for prototype pollution attacks.
 * These are stripped from parsed JSON objects when safe JSON parsing is enabled.
 */
const DANGEROUS_PROPERTIES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Recursively strips dangerous prototype pollution properties from a parsed object.
 * Prevents attacks where malicious JSON payloads inject __proto__ or constructor.prototype
 * to modify Object.prototype and compromise application security.
 */
function stripDangerousProperties(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(stripDangerousProperties);
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (DANGEROUS_PROPERTIES.has(key)) {
      continue; // Strip dangerous property
    }
    cleaned[key] = stripDangerousProperties(value);
  }
  return cleaned;
}

/**
 * Safely parses JSON with prototype pollution protection.
 * Strips __proto__, constructor, and prototype properties from the parsed result.
 */
export function safeJSONParse(text: string): unknown {
  const parsed = JSON.parse(text);
  return stripDangerousProperties(parsed);
}

// ─── Decompression Bomb Protection ─────────────────────────────────────────────

/**
 * Default maximum decompression ratio (compressed:decompressed).
 * A ratio of 100:1 means decompressed data cannot exceed 100x the compressed size.
 * This prevents decompression bomb (zip bomb) attacks where tiny compressed payloads
 * expand to massive sizes consuming all available memory.
 */
export const DEFAULT_MAX_DECOMPRESSION_RATIO = 100;

/**
 * Validates the decompression ratio to detect potential decompression bomb attacks.
 * Returns true if the ratio is within the allowed limit.
 * @param compressedSize - Size of compressed data in bytes
 * @param decompressedSize - Size of decompressed data in bytes
 * @param maxRatio - Maximum allowed decompression ratio (default: 100)
 */
export function checkDecompressionRatio(
  compressedSize: number,
  decompressedSize: number,
  maxRatio: number
): boolean {
  if (compressedSize <= 0) return true; // Can't compute ratio
  const ratio = decompressedSize / compressedSize;
  return ratio <= maxRatio;
}

// ─── Response Header Flood Protection ──────────────────────────────────────────

/**
 * Default maximum number of response headers allowed.
 * Prevents header flooding attacks that exhaust memory with excessive headers.
 */
export const DEFAULT_MAX_RESPONSE_HEADERS = 100;

/**
 * Default maximum total size of all response headers (in bytes).
 */
export const DEFAULT_MAX_RESPONSE_HEADER_SIZE = 64 * 1024; // 64 KB

/**
 * Validates response headers against count and size limits.
 * Throws if limits are exceeded.
 * @param headers - Response headers object
 * @param maxCount - Maximum number of headers allowed
 * @param maxTotalSize - Maximum total size of all headers in bytes
 */
export function validateResponseHeaders(
  headers: Record<string, string>,
  maxCount: number,
  maxTotalSize: number
): void {
  const entries = Object.entries(headers);

  if (entries.length > maxCount) {
    throw new Error(
      `Response header count ${entries.length} exceeds maximum allowed ${maxCount}. ` +
      'This may indicate a header flooding attack.'
    );
  }

  let totalSize = 0;
  for (const [key, value] of entries) {
    totalSize += key.length + value.length + 4; // ": " + "\r\n"
  }

  if (totalSize > maxTotalSize) {
    throw new Error(
      `Response header total size ${totalSize} bytes exceeds maximum allowed ${maxTotalSize} bytes. ` +
      'This may indicate a header flooding attack.'
    );
  }
}

// ─── IDN Homograph Attack Protection ───────────────────────────────────────────

/**
 * Latin look-alike characters commonly used in IDN homograph attacks.
 * Maps Unicode confusable characters to their Latin equivalents.
 */
const CONFUSABLE_CHARS = new Map<string, string>([
  ['\u0430', 'a'], // Cyrillic а
  ['\u0435', 'e'], // Cyrillic е
  ['\u043E', 'o'], // Cyrillic о
  ['\u0440', 'p'], // Cyrillic р
  ['\u0441', 'c'], // Cyrillic с
  ['\u0443', 'y'], // Cyrillic у
  ['\u0445', 'x'], // Cyrillic х
  ['\u0455', 's'], // Cyrillic ѕ
  ['\u0456', 'i'], // Cyrillic і
  ['\u0458', 'j'], // Cyrillic ј
  ['\u04BB', 'h'], // Cyrillic һ
  ['\u0501', 'd'], // Cyrillic ԁ
  ['\u051B', 'q'], // Cyrillic ԛ
  ['\u051D', 'w'], // Cyrillic ԝ
]);

/**
 * Checks if a hostname contains characters from multiple Unicode scripts,
 * which is a common indicator of IDN homograph attacks.
 * Returns true if the hostname is potentially confusable.
 */
export function detectIDNHomograph(hostname: string): boolean {
  // Only check non-ASCII hostnames
  if (/^[\x00-\x7F]+$/.test(hostname)) {
    return false;
  }

  // Check if the hostname contains known confusable characters
  for (const char of hostname) {
    if (CONFUSABLE_CHARS.has(char)) {
      return true;
    }
  }

  // Check for mixed-script: detect if hostname contains both Latin and non-Latin characters
  let hasLatin = false;
  let hasNonLatinAlpha = false;

  for (const char of hostname) {
    const code = char.codePointAt(0)!;
    if (char === '.' || char === '-') continue;

    // Basic Latin letters
    if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
      hasLatin = true;
    } else if (code > 0x7F) {
      // Non-ASCII character that isn't punctuation
      hasNonLatinAlpha = true;
    }
  }

  return hasLatin && hasNonLatinAlpha;
}

/**
 * Normalizes a hostname to its ASCII/punycode representation.
 * Detects and blocks potential IDN homograph attacks.
 * @param hostname - The hostname to normalize
 * @param blockHomographs - Whether to block detected homograph attacks (default: false)
 */
export function normalizeHostname(
  hostname: string,
  blockHomographs: boolean
): string {
  // Already ASCII
  if (/^[\x00-\x7F]+$/.test(hostname)) {
    return hostname.toLowerCase();
  }

  if (blockHomographs && detectIDNHomograph(hostname)) {
    throw new Error(
      `Potential IDN homograph attack detected in hostname "${hostname}". ` +
      'The hostname contains characters from multiple scripts that may be visually confusable. ' +
      'Set blockHomographAttacks: false to allow this.'
    );
  }

  // Convert to punycode for safe comparison
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return punycode.toASCII(hostname).toLowerCase();
  } catch {
    return hostname.toLowerCase();
  }
}

// ─── Content-Length Integrity ───────────────────────────────────────────────────

/**
 * Validates that the actual received body length matches the Content-Length header.
 * Detects potential request smuggling or truncation attacks.
 * @param declaredLength - The Content-Length header value
 * @param actualLength - The actual size of the received body
 */
export function validateContentLengthIntegrity(
  declaredLength: number,
  actualLength: number
): boolean {
  // If no Content-Length header, skip validation
  if (isNaN(declaredLength) || declaredLength < 0) return true;
  return declaredLength === actualLength;
}

// ─── Strict Security Mode ──────────────────────────────────────────────────────

/**
 * Default strict security configuration.
 * When strictSecurity is enabled, all security features are turned on with secure defaults.
 */
export interface StrictSecurityDefaults {
  enforceHttps: boolean;
  dnsProtection: boolean;
  stripSensitiveHeadersOnRedirect: boolean;
  allowHttpsDowngrade: boolean;
  allowPrivateNetworks: boolean;
  blockHomographAttacks: boolean;
  maxResponseHeaders: number;
  maxResponseHeaderSize: number;
  maxDecompressionRatio: number;
  safeJsonParsing: boolean;
  validateContentLength: boolean;
  tlsMinVersion: 'TLSv1.2' | 'TLSv1.3';
}

/**
 * Returns the strict security defaults — the most secure configuration possible.
 * Used when `strictSecurity: true` is set on the request config.
 */
export function getStrictSecurityDefaults(): StrictSecurityDefaults {
  return {
    enforceHttps: true,
    dnsProtection: true,
    stripSensitiveHeadersOnRedirect: true,
    allowHttpsDowngrade: false,
    allowPrivateNetworks: false,
    blockHomographAttacks: true,
    maxResponseHeaders: DEFAULT_MAX_RESPONSE_HEADERS,
    maxResponseHeaderSize: DEFAULT_MAX_RESPONSE_HEADER_SIZE,
    maxDecompressionRatio: DEFAULT_MAX_DECOMPRESSION_RATIO,
    safeJsonParsing: true,
    validateContentLength: true,
    tlsMinVersion: 'TLSv1.3',
  };
}

