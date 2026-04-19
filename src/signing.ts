// ─── HMAC Request Signing ───────────────────────────────────────────────────────

import * as crypto from 'crypto';

export interface RequestSigningConfig {
  /** HMAC algorithm to use (default: 'sha256') */
  algorithm?: 'sha256' | 'sha512';
  /** Secret key for HMAC signing */
  secret: string;
  /** Headers to include in the signature (default: ['host', 'content-type', 'x-request-id']) */
  signedHeaders?: string[];
  /** Name of the header to put the signature in (default: 'X-Signature') */
  headerName?: string;
  /** Name of the header listing which headers were signed (default: 'X-Signed-Headers') */
  signedHeadersListName?: string;
  /** Include request body in signature (default: true) */
  includeBody?: boolean;
  /** Include timestamp in signature to prevent replay attacks (default: true) */
  includeTimestamp?: boolean;
  /** Name of the timestamp header (default: 'X-Signature-Timestamp') */
  timestampHeaderName?: string;
}

const DEFAULT_SIGNING_CONFIG: Required<RequestSigningConfig> = {
  algorithm: 'sha256',
  secret: '',
  signedHeaders: [],
  headerName: 'X-Signature',
  signedHeadersListName: 'X-Signed-Headers',
  includeBody: true,
  includeTimestamp: true,
  timestampHeaderName: 'X-Signature-Timestamp',
};

/**
 * Sign a request using HMAC.
 * Creates a signature over the method, URL, selected headers, timestamp, and optionally the body.
 * Returns the headers to add to the request.
 */
export function signRequest(
  config: RequestSigningConfig,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string | Buffer
): Record<string, string> {
  const resolved: Required<RequestSigningConfig> = {
    ...DEFAULT_SIGNING_CONFIG,
    ...config,
  };

  const additionalHeaders: Record<string, string> = {};

  // Build the string to sign
  const parts: string[] = [];

  // Method and URL
  parts.push(method.toUpperCase());
  parts.push(url);

  // Timestamp
  if (resolved.includeTimestamp) {
    const timestamp = Date.now().toString();
    additionalHeaders[resolved.timestampHeaderName] = timestamp;
    parts.push(`${resolved.timestampHeaderName.toLowerCase()}:${timestamp}`);
  }

  // Signed headers
  const signedHeaderNames: string[] = [];
  for (const headerName of resolved.signedHeaders) {
    const lower = headerName.toLowerCase();
    const value = headers[headerName] || headers[lower] || '';
    parts.push(`${lower}:${value}`);
    signedHeaderNames.push(lower);
  }

  // Body
  if (resolved.includeBody && body) {
    const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');
    // Hash the body separately to avoid issues with large bodies
    const bodyHash = crypto
      .createHash(resolved.algorithm)
      .update(bodyStr)
      .digest('hex');
    parts.push(`body:${bodyHash}`);
  }

  // Create HMAC signature
  const stringToSign = parts.join('\n');
  const signature = crypto
    .createHmac(resolved.algorithm, resolved.secret)
    .update(stringToSign)
    .digest('hex');

  additionalHeaders[resolved.headerName] = signature;

  if (signedHeaderNames.length > 0) {
    additionalHeaders[resolved.signedHeadersListName] = signedHeaderNames.join(';');
  }

  return additionalHeaders;
}

/**
 * Verify an HMAC signature on an incoming request.
 * Useful for webhook verification or testing.
 */
export function verifySignature(
  config: RequestSigningConfig,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string | Buffer,
  signature?: string
): boolean {
  if (!signature) return false;

  const resolved: Required<RequestSigningConfig> = {
    ...DEFAULT_SIGNING_CONFIG,
    ...config,
  };

  const parts: string[] = [];
  parts.push(method.toUpperCase());
  parts.push(url);

  if (resolved.includeTimestamp) {
    const timestamp =
      headers[resolved.timestampHeaderName] ||
      headers[resolved.timestampHeaderName.toLowerCase()] ||
      '';
    parts.push(`${resolved.timestampHeaderName.toLowerCase()}:${timestamp}`);
  }

  for (const headerName of resolved.signedHeaders) {
    const lower = headerName.toLowerCase();
    const value = headers[headerName] || headers[lower] || '';
    parts.push(`${lower}:${value}`);
  }

  if (resolved.includeBody && body) {
    const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');
    const bodyHash = crypto
      .createHash(resolved.algorithm)
      .update(bodyStr)
      .digest('hex');
    parts.push(`body:${bodyHash}`);
  }

  const stringToSign = parts.join('\n');
  const expectedSignature = crypto
    .createHmac(resolved.algorithm, resolved.secret)
    .update(stringToSign)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch {
    return false;
  }
}
