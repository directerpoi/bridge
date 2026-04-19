// ─── HTTP Proxy Support ─────────────────────────────────────────────────────────

import * as http from 'http';
import * as net from 'net';

export interface ProxyConfig {
  /** Proxy host (e.g., 'proxy.example.com') */
  host: string;
  /** Proxy port (e.g., 8080) */
  port: number;
  /** Proxy authentication credentials */
  auth?: {
    username: string;
    password: string;
  };
  /** Protocol of the proxy server (default: 'http') */
  protocol?: 'http' | 'https';
  /** List of hosts that should bypass the proxy (supports wildcards like '*.internal.com') */
  noProxy?: string[];
}

/**
 * Check if a hostname should bypass the proxy based on the noProxy list.
 */
export function shouldBypassProxy(hostname: string, noProxy?: string[]): boolean {
  if (!noProxy || noProxy.length === 0) return false;

  const lower = hostname.toLowerCase();
  for (const pattern of noProxy) {
    const p = pattern.toLowerCase().trim();
    if (p === '*') return true;
    if (p === lower) return true;

    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      if (lower.endsWith(suffix) || lower === p.slice(2)) return true;
    }
  }

  return false;
}

/**
 * Create a TCP connection through an HTTP proxy using the CONNECT method.
 * Used to tunnel HTTPS requests through an HTTP proxy.
 */
export function createProxyTunnel(
  proxyConfig: ProxyConfig,
  targetHost: string,
  targetPort: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const proxyHeaders: Record<string, string> = {
      'Host': `${targetHost}:${targetPort}`,
    };

    // Proxy authentication
    if (proxyConfig.auth) {
      const creds = `${proxyConfig.auth.username}:${proxyConfig.auth.password}`;
      proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    }

    const connectReq = http.request({
      hostname: proxyConfig.host,
      port: proxyConfig.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxyHeaders,
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(
          new Error(
            `Proxy CONNECT failed with status ${res.statusCode}: ${res.statusMessage}`
          )
        );
      }
    });

    connectReq.on('error', (err) => {
      reject(new Error(`Proxy connection failed: ${err.message}`));
    });

    connectReq.on('timeout', () => {
      connectReq.destroy();
      reject(new Error('Proxy connection timed out'));
    });

    connectReq.end();
  });
}

/**
 * Build HTTP request options for sending a request through an HTTP proxy
 * (non-CONNECT, used for plain HTTP proxying).
 */
export function buildProxyRequestOptions(
  proxyConfig: ProxyConfig,
  targetURL: string,
  method: string,
  headers: Record<string, string>
): http.RequestOptions {
  const proxyHeaders = { ...headers };

  if (proxyConfig.auth) {
    const creds = `${proxyConfig.auth.username}:${proxyConfig.auth.password}`;
    proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
  }

  return {
    hostname: proxyConfig.host,
    port: proxyConfig.port,
    method,
    path: targetURL, // Full URL for HTTP proxy
    headers: proxyHeaders,
  };
}
