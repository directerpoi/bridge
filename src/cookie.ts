// ─── Cookie Jar ─────────────────────────────────────────────────────────────────

/**
 * Represents a parsed HTTP cookie.
 */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: Date;
  maxAge?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  createdAt: number;
}

export interface CookieJarConfig {
  /** Maximum number of cookies to store (default: 1000) */
  maxCookies: number;
  /** Whether to only store cookies marked as Secure (default: false) */
  secureOnly: boolean;
}

const DEFAULT_COOKIE_JAR_CONFIG: CookieJarConfig = {
  maxCookies: 1000,
  secureOnly: false,
};

/**
 * In-memory cookie jar that automatically manages HTTP cookies.
 * Supports domain scoping, path matching, expiration, and Secure/HttpOnly flags.
 */
export class CookieJar {
  private cookies: Cookie[] = [];
  private config: CookieJarConfig;

  constructor(config?: Partial<CookieJarConfig>) {
    this.config = { ...DEFAULT_COOKIE_JAR_CONFIG, ...config };
  }

  /**
   * Parse Set-Cookie headers from a response and store them.
   * @param setCookieHeaders - Array of Set-Cookie header values
   * @param requestDomain - The domain of the request that received these cookies
   * @param requestPath - The path of the request
   */
  setCookies(
    setCookieHeaders: string[],
    requestDomain: string,
    requestPath: string
  ): void {
    for (const header of setCookieHeaders) {
      const cookie = parseCookie(header, requestDomain, requestPath);
      if (!cookie) continue;

      if (this.config.secureOnly && !cookie.secure) continue;

      // Remove any existing cookie with the same name, domain, and path
      this.cookies = this.cookies.filter(
        (c) =>
          !(
            c.name === cookie.name &&
            c.domain === cookie.domain &&
            c.path === cookie.path
          )
      );

      // Evict oldest if at max
      if (this.cookies.length >= this.config.maxCookies) {
        this.cookies.shift();
      }

      this.cookies.push(cookie);
    }
  }

  /**
   * Get the Cookie header value for a given URL.
   * Returns the cookie string (e.g., "name1=value1; name2=value2") or empty string.
   */
  getCookieHeader(domain: string, path: string, isSecure: boolean): string {
    this.removeExpired();

    const matching = this.cookies.filter((cookie) => {
      // Domain check: the request domain must match or be a subdomain
      if (!domainMatches(domain, cookie.domain)) return false;

      // Path check: the request path must start with the cookie path
      if (!pathMatches(path, cookie.path)) return false;

      // Secure check: secure cookies only sent over HTTPS
      if (cookie.secure && !isSecure) return false;

      return true;
    });

    // Sort by path specificity (longer paths first), then by creation time
    matching.sort((a, b) => {
      if (a.path.length !== b.path.length) return b.path.length - a.path.length;
      return a.createdAt - b.createdAt;
    });

    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * Remove expired cookies.
   */
  private removeExpired(): void {
    const now = Date.now();
    this.cookies = this.cookies.filter((cookie) => {
      if (cookie.maxAge !== undefined) {
        return now - cookie.createdAt < cookie.maxAge * 1000;
      }
      if (cookie.expires) {
        return cookie.expires.getTime() > now;
      }
      // Session cookies (no expiry) are always valid
      return true;
    });
  }

  /**
   * Clear all cookies.
   */
  clear(): void {
    this.cookies = [];
  }

  /**
   * Clear cookies for a specific domain.
   */
  clearDomain(domain: string): void {
    this.cookies = this.cookies.filter(
      (c) => c.domain.toLowerCase() !== domain.toLowerCase()
    );
  }

  /**
   * Get the total number of stored cookies.
   */
  get size(): number {
    this.removeExpired();
    return this.cookies.length;
  }

  /**
   * Get all cookies (for debugging/inspection).
   */
  getAllCookies(): ReadonlyArray<Cookie> {
    this.removeExpired();
    return [...this.cookies];
  }
}

/**
 * Parse a Set-Cookie header string into a Cookie object.
 */
function parseCookie(
  header: string,
  requestDomain: string,
  requestPath: string
): Cookie | null {
  const parts = header.split(';').map((p) => p.trim());
  if (parts.length === 0) return null;

  const nameValue = parts[0];
  const eqIndex = nameValue.indexOf('=');
  if (eqIndex < 1) return null;

  const name = nameValue.substring(0, eqIndex).trim();
  const value = nameValue.substring(eqIndex + 1).trim();

  const cookie: Cookie = {
    name,
    value,
    domain: requestDomain.toLowerCase(),
    path: getDefaultPath(requestPath),
    secure: false,
    httpOnly: false,
    createdAt: Date.now(),
  };

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const attrEq = part.indexOf('=');
    let attrName: string;
    let attrValue: string;

    if (attrEq >= 0) {
      attrName = part.substring(0, attrEq).trim().toLowerCase();
      attrValue = part.substring(attrEq + 1).trim();
    } else {
      attrName = part.trim().toLowerCase();
      attrValue = '';
    }

    switch (attrName) {
      case 'domain': {
        let d = attrValue.toLowerCase();
        // Remove leading dot (e.g., ".example.com" → "example.com")
        if (d.startsWith('.')) d = d.substring(1);
        // Validate: the request domain must be the same or a subdomain
        if (domainMatches(requestDomain, d)) {
          cookie.domain = d;
        }
        break;
      }
      case 'path':
        cookie.path = attrValue || '/';
        break;
      case 'expires': {
        const date = new Date(attrValue);
        if (!isNaN(date.getTime())) {
          cookie.expires = date;
        }
        break;
      }
      case 'max-age': {
        const seconds = parseInt(attrValue, 10);
        if (!isNaN(seconds)) {
          cookie.maxAge = seconds;
        }
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        if (['strict', 'lax', 'none'].includes(attrValue.toLowerCase())) {
          cookie.sameSite = (attrValue.charAt(0).toUpperCase() + attrValue.slice(1).toLowerCase()) as Cookie['sameSite'];
        }
        break;
    }
  }

  return cookie;
}

/**
 * Check if a request domain matches a cookie domain.
 * e.g., "sub.example.com" matches "example.com"
 */
function domainMatches(requestDomain: string, cookieDomain: string): boolean {
  const reqLower = requestDomain.toLowerCase();
  const cookieLower = cookieDomain.toLowerCase();

  if (reqLower === cookieLower) return true;
  if (reqLower.endsWith('.' + cookieLower)) return true;

  return false;
}

/**
 * Check if a request path matches a cookie path.
 */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    // Exact prefix or the cookie path ends with /
    if (cookiePath.endsWith('/')) return true;
    // Or the next char in request path is /
    if (requestPath.charAt(cookiePath.length) === '/') return true;
  }
  return false;
}

/**
 * Get the default cookie path from a request path.
 */
function getDefaultPath(requestPath: string): string {
  if (!requestPath || !requestPath.startsWith('/')) return '/';
  const lastSlash = requestPath.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return requestPath.substring(0, lastSlash);
}

/**
 * Resolves cookie jar configuration from user input.
 */
export function resolveCookieJarConfig(
  input: boolean | Partial<CookieJarConfig> | undefined
): CookieJarConfig | null {
  if (!input) return null;
  if (input === true) return { ...DEFAULT_COOKIE_JAR_CONFIG };
  return { ...DEFAULT_COOKIE_JAR_CONFIG, ...input };
}
