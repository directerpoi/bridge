import * as url from 'url';
import * as net from 'net';
import * as dns from 'dns';
import * as crypto from 'crypto';
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

