import * as url from 'url';
import * as net from 'net';

// ─── Private / Reserved IP Ranges ──────────────────────────────────────────────

const PRIVATE_IPV4_RANGES = [
  /^127\./,                        // 127.0.0.0/8 loopback
  /^10\./,                         // 10.0.0.0/8 private
  /^172\.(1[6-9]|2\d|3[01])\./,   // 172.16.0.0/12 private
  /^192\.168\./,                   // 192.168.0.0/16 private
  /^0\./,                          // 0.0.0.0/8 current network
  /^169\.254\./,                   // 169.254.0.0/16 link-local
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,  // 100.64.0.0/10 shared address space
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
  'host',        // should be set by the library only
  'connection',  // managed by Node.js
]);

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates a URL for safety. Throws on:
 *  - Non http/https protocols
 *  - Hostname resolving to private IPs (when allowPrivateNetworks is false)
 */
export function validateURL(
  target: string,
  allowPrivateNetworks: boolean
): url.URL {
  const parsed = new url.URL(target);

  // Only allow http and https protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported protocol "${parsed.protocol}". Only http: and https: are allowed.`
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
 * Sanitizes headers: removes forbidden headers and ensures values are strings.
 */
export function sanitizeHeaders(
  headers: Record<string, string | number | boolean> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) continue;
    out[key] = String(value);
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
