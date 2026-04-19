// ─── HTTP/2 Support ─────────────────────────────────────────────────────────────

import * as http2 from 'http2';
import * as tls from 'tls';
import { TLSConfig } from './types';

export interface HTTP2Config {
  /** Enable HTTP/2 for HTTPS requests (default: false) */
  enabled: boolean;
  /** Timeout for the HTTP/2 session in ms (default: 60000). Set to 0 for no timeout. */
  sessionTimeout?: number;
  /** Maximum concurrent streams per session (default: 100) */
  maxConcurrentStreams?: number;
  /** Reuse sessions for same origin (default: true) */
  reuseSessions?: boolean;
}

const DEFAULT_HTTP2_CONFIG: Required<HTTP2Config> = {
  enabled: false,
  sessionTimeout: 60_000,
  maxConcurrentStreams: 100,
  reuseSessions: true,
};

/**
 * Manages HTTP/2 sessions with connection pooling per origin.
 */
export class HTTP2SessionManager {
  private sessions = new Map<string, http2.ClientHttp2Session>();
  private config: Required<HTTP2Config>;

  constructor(config?: Partial<HTTP2Config>) {
    this.config = { ...DEFAULT_HTTP2_CONFIG, ...config };
  }

  /**
   * Get or create an HTTP/2 session for the given origin.
   * @param origin - The origin URL (e.g., 'https://example.com')
   * @param tlsConfig - Optional TLS configuration
   */
  getSession(
    origin: string,
    tlsConfig?: TLSConfig
  ): http2.ClientHttp2Session {
    if (this.config.reuseSessions) {
      const existing = this.sessions.get(origin);
      if (existing && !existing.closed && !existing.destroyed) {
        return existing;
      }
      // Remove stale entry
      this.sessions.delete(origin);
    }

    const connectOptions: http2.SecureClientSessionOptions = {
      rejectUnauthorized: tlsConfig?.rejectUnauthorized ?? true,
    };

    if (tlsConfig) {
      if (tlsConfig.ca) connectOptions.ca = tlsConfig.ca;
      if (tlsConfig.cert) connectOptions.cert = tlsConfig.cert;
      if (tlsConfig.key) connectOptions.key = tlsConfig.key;
      if (tlsConfig.pfx) connectOptions.pfx = tlsConfig.pfx;
      if (tlsConfig.passphrase) connectOptions.passphrase = tlsConfig.passphrase;
      if (tlsConfig.minVersion) connectOptions.minVersion = tlsConfig.minVersion;
      if (tlsConfig.ciphers) connectOptions.ciphers = tlsConfig.ciphers;
    }

    if (this.config.maxConcurrentStreams) {
      connectOptions.settings = {
        maxConcurrentStreams: this.config.maxConcurrentStreams,
      };
    }

    const session = http2.connect(origin, connectOptions);

    // Set session timeout
    if (this.config.sessionTimeout > 0) {
      session.setTimeout(this.config.sessionTimeout, () => {
        session.close();
      });
    }

    // Auto-clean on close
    session.on('close', () => {
      this.sessions.delete(origin);
    });

    session.on('error', () => {
      this.sessions.delete(origin);
    });

    if (this.config.reuseSessions) {
      this.sessions.set(origin, session);
    }

    return session;
  }

  /**
   * Make an HTTP/2 request using the session manager.
   */
  request(
    origin: string,
    path: string,
    method: string,
    headers: Record<string, string>,
    body?: string | Buffer,
    tlsConfig?: TLSConfig,
    certFingerprint?: string
  ): Promise<HTTP2Response> {
    return new Promise((resolve, reject) => {
      let session: http2.ClientHttp2Session;
      try {
        session = this.getSession(origin, tlsConfig);
      } catch (err) {
        reject(err);
        return;
      }

      const reqHeaders: http2.OutgoingHttpHeaders = {
        [http2.constants.HTTP2_HEADER_METHOD]: method,
        [http2.constants.HTTP2_HEADER_PATH]: path,
        ...headers,
      };

      // Remove lowercase host header (HTTP/2 uses :authority)
      delete reqHeaders['host'];
      delete reqHeaders['Host'];

      const req = session.request(reqHeaders);

      // Certificate pinning for HTTP/2
      if (certFingerprint) {
        const socket = session.socket as tls.TLSSocket;
        if (socket && typeof socket.getPeerCertificate === 'function') {
          const cert = socket.getPeerCertificate();
          if (cert && cert.fingerprint256) {
            const normalizedExpected = certFingerprint.toUpperCase().replace(/:/g, '');
            const normalizedActual = cert.fingerprint256.toUpperCase().replace(/:/g, '');
            if (normalizedExpected !== normalizedActual) {
              req.close();
              reject(
                new Error(
                  `Certificate fingerprint mismatch. Expected: ${certFingerprint}, Got: ${cert.fingerprint256}`
                )
              );
              return;
            }
          }
        }
      }

      const responseHeaders: Record<string, string> = {};
      let status = 0;

      req.on('response', (hdrs) => {
        status = Number(hdrs[http2.constants.HTTP2_HEADER_STATUS]) || 0;
        for (const [key, value] of Object.entries(hdrs)) {
          if (key.startsWith(':')) continue; // Skip pseudo-headers
          if (value !== undefined) {
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
          }
        }
      });

      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve({
          status,
          headers: responseHeaders,
          data,
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      // Write body
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * Close all active sessions.
   */
  closeAll(): void {
    for (const [, session] of this.sessions) {
      if (!session.closed && !session.destroyed) {
        session.close();
      }
    }
    this.sessions.clear();
  }

  /**
   * Close a session for a specific origin.
   */
  closeSession(origin: string): void {
    const session = this.sessions.get(origin);
    if (session && !session.closed && !session.destroyed) {
      session.close();
    }
    this.sessions.delete(origin);
  }

  /**
   * Get the number of active sessions.
   */
  get activeSessions(): number {
    // Clean up stale entries
    for (const [key, session] of this.sessions) {
      if (session.closed || session.destroyed) {
        this.sessions.delete(key);
      }
    }
    return this.sessions.size;
  }
}

export interface HTTP2Response {
  status: number;
  headers: Record<string, string>;
  data: Buffer;
}

/**
 * Resolves HTTP/2 configuration from user input.
 */
export function resolveHTTP2Config(
  input: boolean | Partial<HTTP2Config> | undefined
): Required<HTTP2Config> | null {
  if (!input) return null;
  if (input === true) return { ...DEFAULT_HTTP2_CONFIG, enabled: true };
  if (!input.enabled) return null;
  return { ...DEFAULT_HTTP2_CONFIG, ...input };
}
