# 🌉 Bridge

**A powerful, secure, and lightning-fast HTTP client for Node.js.**

Bridge is a zero-dependency HTTP client with an axios-compatible API. Drop-in replacement with enhanced security features, automatic compression, and full TypeScript support.

## ✨ Features

- **🔄 Axios-compatible API** — familiar `get`, `post`, `put`, `patch`, `delete`, `head`, `options` methods
- **🔒 Security-first** — SSRF protection, DNS rebinding protection, URL validation, header injection prevention, content size limits
- **🔐 TLS/SSL** — certificate pinning, custom CA, mTLS (mutual TLS), minimum TLS version enforcement
- **🔁 Automatic Retry** — exponential backoff with jitter, configurable retry conditions
- **⚡ Zero dependencies** — built on Node.js `http`/`https` modules only
- **📦 Auto JSON** — automatic request serialization and response parsing
- **🗜️ Decompression** — automatic gzip, deflate, and brotli decompression
- **🔀 Interceptors** — request and response interceptors (axios-style)
- **🔄 Transformers** — request and response data transformers
- **⏱️ Timeouts** — configurable connection and response body timeouts
- **🔁 Redirects** — automatic redirect following with configurable limits
- **❌ Cancellation** — AbortController and CancelToken support
- **🆔 Request Tracking** — automatic X-Request-ID header injection
- **🔒 HTTPS Enforcement** — option to reject all non-HTTPS requests
- **📝 TypeScript** — full type definitions included

### v7.0.0 — Maximum Power

- **🌐 HTTP/2 Support** — multiplexed streams over a single connection, session pooling, automatic protocol negotiation via Node.js built-in `http2` module
- **🔗 Proxy Support** — HTTP CONNECT tunneling for HTTPS through HTTP proxies, proxy authentication, noProxy bypass lists
- **🍪 Cookie Jar** — automatic cookie management across requests with domain/path scoping, Secure/HttpOnly flag support, expiration via Max-Age/Expires
- **🏎️ DNS Caching** — in-memory DNS resolution cache with configurable TTL and LRU eviction for faster repeat requests
- **🔧 Middleware Pipeline** — composable onion-model middleware chain for custom request/response processing (like Koa)

### v5.0.0 — Enhanced Security

- **🛡️ Domain Allowlist** — restrict requests to approved domains only, with wildcard subdomain support
- **🚫 Domain Blocklist** — block requests to specific domains, with wildcard subdomain support
- **🔐 Sensitive Header Stripping on Redirects** — automatically strips `Authorization`, `Cookie`, and `Proxy-Authorization` headers on cross-origin redirects (enabled by default)
- **🔒 HTTPS Downgrade Protection** — blocks HTTPS → HTTP protocol downgrades on redirects by default

### v4.0.0 — New Features

- **🚦 Rate Limiting** — built-in token bucket rate limiter to control request throughput
- **⚡ Circuit Breaker** — fault tolerance with open/half-open/closed states to prevent cascading failures
- **🔀 Concurrency Control** — limit maximum parallel requests with automatic queuing
- **📊 Progress Events** — upload and download progress callbacks with rate and ETA estimation
- **⏱️ Request Timeline** — detailed timing metrics (DNS, TCP, TLS, TTFB, download, total)
- **🪝 Event Hooks** — lifecycle hooks (`onRequest`, `onResponse`, `onError`, `onRetry`)

## 📦 Installation

```bash
npm install bridge
```

## 🚀 Quick Start

```typescript
import bridge from 'bridge';

// GET request
const response = await bridge.get('https://api.example.com/users');
console.log(response.data);

// POST request with JSON body
const { data } = await bridge.post('https://api.example.com/users', {
  name: 'John',
  email: 'john@example.com',
});
```

## 📖 API

### Request Methods

```typescript
bridge.get(url[, config])
bridge.delete(url[, config])
bridge.head(url[, config])
bridge.options(url[, config])
bridge.post(url[, data[, config]])
bridge.put(url[, data[, config]])
bridge.patch(url[, data[, config]])
bridge.request(config)
```

### Creating an Instance

```typescript
const api = bridge.create({
  baseURL: 'https://api.example.com',
  timeout: 5000,
  headers: {
    'Authorization': 'Bearer token123',
  },
});

const users = await api.get('/users');
```

### Request Config

```typescript
{
  url: '/users',
  method: 'GET',
  baseURL: 'https://api.example.com',
  headers: { 'X-Custom-Header': 'value' },
  params: { page: 1, limit: 10 },
  data: { name: 'John' },
  timeout: 5000,
  responseTimeout: 30000,       // separate timeout for response body download
  responseType: 'json',         // 'json' | 'text' | 'arraybuffer' | 'stream'
  maxContentLength: 50 * 1024 * 1024,
  maxBodyLength: 50 * 1024 * 1024,
  maxRedirects: 5,
  validateStatus: (status) => status >= 200 && status < 300,
  auth: { username: 'user', password: 'pass' },
  decompress: true,
  signal: controller.signal,

  // Security
  allowPrivateNetworks: false,   // SSRF protection
  maxHeaderSize: 16384,
  enforceHttps: false,           // reject all non-HTTPS requests
  dnsProtection: false,          // DNS-based SSRF protection

  // Retry
  retry: true,                   // or { retries: 3, delay: 300, ... }

  // TLS/SSL
  tls: {
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    ca: '...',                   // custom CA certificate
    cert: '...',                 // client certificate (mTLS)
    key: '...',                  // client private key (mTLS)
    certFingerprint: '...',      // certificate pinning (SHA-256)
    ciphers: '...',              // allowed cipher suites
  },

  // Transformers
  transformRequest: [(data, headers) => { ... }],
  transformResponse: [(data) => { ... }],

  // Observability
  requestId: true,               // auto-inject X-Request-ID (UUID v4)

  // v4.0.0: Progress Events
  onUploadProgress: (event) => console.log(`Upload: ${event.progress}%`),
  onDownloadProgress: (event) => console.log(`Download: ${event.progress}%`),

  // v4.0.0: Request Timeline
  collectTimeline: true,         // collect timing metrics

  // v4.0.0: Event Hooks
  hooks: {
    onRequest: (config) => console.log('Request started:', config.url),
    onResponse: (res) => console.log('Response:', res.status),
    onError: (err) => console.error('Error:', err.message),
    onRetry: (attempt, err, delay) => console.log(`Retry #${attempt} in ${delay}ms`),
  },
}
```

### Response Object

```typescript
{
  data: {},           // Response body (parsed)
  status: 200,       // HTTP status code
  statusText: 'OK',  // HTTP status text
  headers: {},       // Response headers
  config: {},        // Request config
  timeline: {        // v4.0.0: Only when collectTimeline: true
    startTime: 1713420166717,
    dnsLookup: 5,
    tcpConnect: 12,
    tlsHandshake: 25,
    firstByte: 42,
    contentDownload: 8,
    total: 50,
  },
}
```

### Interceptors

```typescript
// Request interceptor
bridge.interceptors.request.use(
  (config) => {
    config.headers = { ...config.headers, 'Authorization': 'Bearer token' };
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor
bridge.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Handle unauthorized
    }
    return Promise.reject(error);
  }
);

// Remove interceptor
const id = bridge.interceptors.request.use(/* ... */);
bridge.interceptors.request.eject(id);
```

### Cancellation

```typescript
// Using AbortController (recommended)
const controller = new AbortController();
bridge.get('/users', { signal: controller.signal });
controller.abort();

// Using CancelToken (axios compatibility)
import { CancelToken } from 'bridge';
const source = CancelToken.source();
bridge.get('/users', { signal: source.token });
source.cancel('Operation cancelled');
```

### Error Handling

```typescript
import { isBridgeError } from 'bridge';

try {
  await bridge.get('https://api.example.com/users');
} catch (error) {
  if (isBridgeError(error)) {
    console.log(error.response?.status);  // 404
    console.log(error.response?.data);    // Error body
    console.log(error.code);              // 'ERR_BAD_RESPONSE'
  }
}
```

### Utility Methods

```typescript
// Concurrent requests
const [users, posts] = await bridge.all([
  bridge.get('/users'),
  bridge.get('/posts'),
]);

// Get URI without making request
const uri = bridge.getUri({ baseURL: 'https://api.example.com', url: '/users', params: { page: 1 } });
// => 'https://api.example.com/users?page=1'
```

## 🔁 Automatic Retry

Bridge supports automatic retry with exponential backoff and jitter for transient failures.

```typescript
// Enable with defaults (3 retries, 300ms initial delay, 2x backoff)
const res = await bridge.get('https://api.example.com/data', {
  retry: true,
});

// Custom retry configuration
const res = await bridge.get('https://api.example.com/data', {
  retry: {
    retries: 5,              // max retry attempts
    delay: 500,              // initial delay in ms
    maxDelay: 30000,         // maximum delay between retries
    backoffFactor: 2,        // exponential backoff multiplier
    retryableMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'],
    retryableStatuses: [408, 429, 500, 502, 503, 504],
    retryCondition: (error) => {
      // Custom logic: retry only on specific conditions
      return error.response?.status === 503;
    },
  },
});
```

**Default retry behavior:**
- Methods: GET, HEAD, OPTIONS, PUT, DELETE (idempotent methods)
- Status codes: 408, 429, 500, 502, 503, 504
- Network errors are always retried
- Backoff includes jitter (0.5x–1.5x) to prevent thundering herd

## 🔐 TLS/SSL & Encryption

### Certificate Pinning

Pin a specific server certificate by its SHA-256 fingerprint:

```typescript
const res = await bridge.get('https://api.example.com/secure', {
  tls: {
    certFingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  },
});
```

### Mutual TLS (mTLS)

Authenticate with a client certificate:

```typescript
import * as fs from 'fs';

const res = await bridge.get('https://api.internal.com/data', {
  tls: {
    cert: fs.readFileSync('/path/to/client.crt'),
    key: fs.readFileSync('/path/to/client.key'),
    ca: fs.readFileSync('/path/to/ca.crt'),
  },
});
```

### Minimum TLS Version

Enforce a minimum TLS version:

```typescript
const api = bridge.create({
  tls: {
    minVersion: 'TLSv1.3',  // Only allow TLS 1.3
    rejectUnauthorized: true,
  },
});
```

### Custom Cipher Suites

```typescript
const api = bridge.create({
  tls: {
    ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
  },
});
```

## 🔄 Request & Response Transformers

Transform data before it's sent or after it's received:

```typescript
const api = bridge.create({
  transformRequest: [
    (data, headers) => {
      // Encrypt request payload
      headers['Content-Type'] = 'application/encrypted';
      return encrypt(data);
    },
  ],
  transformResponse: [
    (data) => {
      // Decrypt response payload
      return decrypt(data);
    },
  ],
});
```

## 🆔 Request ID Tracking

Automatically inject unique request IDs for distributed tracing:

```typescript
// Auto-generate UUID v4
const res = await bridge.get('https://api.example.com/data', {
  requestId: true,  // injects X-Request-ID: <uuid-v4>
});

// Custom request ID
const res = await bridge.get('https://api.example.com/data', {
  requestId: 'trace-abc-123',  // injects X-Request-ID: trace-abc-123
});
```

## ⏱️ Dual Timeout Support

Separate connection timeout from response body download timeout:

```typescript
const res = await bridge.get('https://api.example.com/large-file', {
  timeout: 5000,           // 5s to establish connection
  responseTimeout: 60000,  // 60s to download the full response body
});
```

## 🔒 Security Features

### SSRF Protection

By default, Bridge blocks requests to private/reserved IP addresses (127.x.x.x, 10.x.x.x, 192.168.x.x, etc.) to prevent Server-Side Request Forgery attacks.

```typescript
// This will throw an error
await bridge.get('http://127.0.0.1:8080/admin');

// Explicitly allow if needed (e.g., in development)
await bridge.get('http://127.0.0.1:8080/admin', {
  allowPrivateNetworks: true,
});
```

### DNS Rebinding Protection

Resolve hostnames and validate resolved IPs before connecting to prevent DNS rebinding attacks:

```typescript
const res = await bridge.get('https://api.example.com/data', {
  dnsProtection: true,  // resolves hostname, validates IP, then connects
});
```

### HTTPS Enforcement

Force all requests to use HTTPS:

```typescript
const secureClient = bridge.create({
  enforceHttps: true,
});

await secureClient.get('http://api.example.com/data');
// Throws: "HTTPS is enforced"
```

### Header Injection Prevention

Bridge automatically detects and blocks header injection attacks (newline characters, null bytes in header names or values).

### Protocol Validation

Only `http:` and `https:` protocols are allowed. Attempts to use `file:`, `ftp:`, or other protocols are blocked.

### URL Credential Blocking

URLs with embedded credentials (`http://user:pass@host`) are blocked to prevent credential leakage. Use the `auth` config option instead.

### Content Size Limits

Configurable limits on both request body and response size to prevent memory exhaustion:

```typescript
const res = await bridge.get('/large-file', {
  maxContentLength: 10 * 1024 * 1024, // 10 MB max response
  maxBodyLength: 5 * 1024 * 1024,     // 5 MB max request body
});
```

### Header Sanitization

Dangerous headers (`Host`, `Connection`, `Transfer-Encoding`, `Upgrade`, `Proxy-Authorization`, `TE`) are automatically stripped from user-provided headers.

### Comprehensive IP Range Blocking

Beyond basic private IP ranges, Bridge also blocks:
- Benchmark testing ranges (198.18.0.0/15)
- IANA special purpose (192.0.0.0/24)
- TEST-NET ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
- Multicast & reserved ranges (224.0.0.0/4, 240.0.0.0/4)
- IPv6 multicast (ff00::/8)

### Domain Allowlist / Blocklist *(v5.0.0)*

Restrict which domains your application can communicate with:

```typescript
// Only allow requests to specific domains
const api = bridge.create({
  allowedDomains: ['api.example.com', '*.trusted-partner.com'],
});

await api.get('https://api.example.com/data');     // ✅ Allowed
await api.get('https://evil.com/steal');            // ❌ Blocked

// Block specific domains
const safe = bridge.create({
  blockedDomains: ['evil.com', '*.malware.net'],
});

await safe.get('https://api.example.com/data');     // ✅ Allowed
await safe.get('https://evil.com/steal');            // ❌ Blocked
await safe.get('https://sub.malware.net/payload');   // ❌ Blocked
```

Wildcard patterns (`*.example.com`) match the base domain and all subdomains. The blocklist is evaluated before the allowlist — if a domain appears in both, it is blocked.

### Sensitive Header Stripping on Redirects *(v5.0.0)*

When following redirects to a different origin, Bridge automatically strips sensitive headers (`Authorization`, `Cookie`, `Proxy-Authorization`) to prevent credential leakage. This is enabled by default:

```typescript
// Sensitive headers are stripped on cross-origin redirects (default behavior)
await bridge.get('https://api.example.com/endpoint', {
  headers: { 'Authorization': 'Bearer token' },
});
// If the server redirects to https://other.com/callback,
// the Authorization header is automatically removed.

// Disable if you explicitly need to forward credentials across origins
await bridge.get('https://api.example.com/endpoint', {
  stripSensitiveHeadersOnRedirect: false,
  headers: { 'Authorization': 'Bearer token' },
});
```

### HTTPS Downgrade Protection *(v5.0.0)*

Bridge blocks redirects that downgrade from HTTPS to HTTP by default, preventing man-in-the-middle exposure of encrypted traffic:

```typescript
// HTTPS → HTTP redirects are blocked by default
await bridge.get('https://api.example.com/endpoint');
// If the server redirects to http://api.example.com/other,
// Bridge throws: "Redirect from HTTPS to HTTP is blocked"

// Allow downgrade if explicitly needed (not recommended)
await bridge.get('https://api.example.com/endpoint', {
  allowHttpsDowngrade: true,
});
```

## 🚦 Rate Limiting

Control request throughput with a built-in token bucket rate limiter:

```typescript
const api = bridge.create({ baseURL: 'https://api.example.com' });

// Allow max 10 requests per second
api.setRateLimiter({ maxRequests: 10, windowMs: 1000 });

// Requests exceeding the limit are automatically queued and delayed
const results = await Promise.all([
  api.get('/data/1'),
  api.get('/data/2'),
  api.get('/data/3'),
  // ...more requests — they'll be paced automatically
]);

// Use defaults (10 req/s)
api.setRateLimiter(true);

// Disable rate limiting
api.setRateLimiter(false);
```

You can also use the `RateLimiter` class standalone:

```typescript
import { RateLimiter } from 'bridge';

const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
console.log(limiter.getAvailableTokens()); // 5
limiter.tryAcquire(); // true — immediate
await limiter.acquire(); // waits if necessary
limiter.reset(); // refill all tokens
```

## ⚡ Circuit Breaker

Prevent cascading failures with the circuit breaker pattern:

```typescript
const api = bridge.create({ baseURL: 'https://api.example.com' });

api.setCircuitBreaker({
  failureThreshold: 5,    // open after 5 consecutive failures
  resetTimeout: 30000,    // try again after 30s
  halfOpenRequests: 1,    // allow 1 test request in half-open state
  onStateChange: (from, to) => {
    console.log(`Circuit: ${from} → ${to}`);
  },
});

// Check circuit state
console.log(api.getCircuitState()); // 'closed' | 'open' | 'half-open'

try {
  await api.get('/data');
} catch (err) {
  if (err.code === 'ERR_CIRCUIT_OPEN') {
    console.log('Service is down — circuit is open');
  }
}
```

**Circuit breaker states:**
- **closed** — normal operation, requests flow through
- **open** — requests are immediately rejected (fast-fail) after too many failures
- **half-open** — limited requests allowed to test if the service has recovered

## 🔀 Concurrency Control

Limit the number of parallel requests with automatic queuing:

```typescript
const api = bridge.create({ baseURL: 'https://api.example.com' });

// Allow max 5 concurrent requests
api.setConcurrency(5);

// Or with config object
api.setConcurrency({ maxConcurrent: 5 });

// Launch 20 requests — only 5 run at a time, rest are queued
const results = await Promise.all(
  ids.map(id => api.get(`/users/${id}`))
);
```

## 📊 Progress Events

Track upload and download progress with detailed metrics:

```typescript
// Download progress
const res = await bridge.get('https://api.example.com/large-file', {
  onDownloadProgress: (event) => {
    console.log(`Downloaded: ${event.loaded} bytes`);
    console.log(`Total: ${event.total} bytes`);
    console.log(`Progress: ${event.progress}%`);
    console.log(`Speed: ${(event.rate / 1024).toFixed(1)} KB/s`);
    console.log(`ETA: ${event.estimated}ms`);
  },
});

// Upload progress
await bridge.post('https://api.example.com/upload', largePayload, {
  onUploadProgress: (event) => {
    console.log(`Uploaded: ${event.progress}%`);
    console.log(`Rate: ${(event.rate / 1024 / 1024).toFixed(1)} MB/s`);
  },
});
```

**Progress event shape:**
```typescript
{
  loaded: number;    // bytes transferred so far
  total: number;     // total bytes (0 if unknown)
  progress: number;  // 0-100 percentage (-1 if unknown)
  rate: number;      // bytes per second
  estimated: number; // estimated time remaining in ms
}
```

## ⏱️ Request Timeline

Collect detailed timing metrics for every phase of the request:

```typescript
const res = await bridge.get('https://api.example.com/data', {
  collectTimeline: true,
});

console.log(res.timeline);
// {
//   startTime: 1713420166717,  // Unix timestamp
//   dnsLookup: 5,              // DNS resolution (ms)
//   tcpConnect: 12,            // TCP connection (ms)
//   tlsHandshake: 25,          // TLS handshake (ms, 0 for HTTP)
//   firstByte: 42,             // Time to first byte (ms)
//   contentDownload: 8,        // Content download (ms)
//   total: 50,                 // Total duration (ms)
// }
```

## 🪝 Event Hooks

Subscribe to request lifecycle events for logging, monitoring, or custom logic:

```typescript
const api = bridge.create({
  hooks: {
    onRequest: (config) => {
      console.log(`→ ${config.method} ${config.url}`);
    },
    onResponse: (response) => {
      console.log(`← ${response.status} (${response.timeline?.total}ms)`);
    },
    onError: (error) => {
      console.error(`✗ ${error.code}: ${error.message}`);
    },
    onRetry: (attempt, error, delay) => {
      console.warn(`↻ Retry #${attempt} in ${delay}ms (${error.code})`);
    },
  },
});
```

Hooks can also be set per-request:

```typescript
await api.get('/data', {
  hooks: {
    onResponse: (res) => metrics.record(res.timeline),
  },
});
```

## 🔄 Migrating from Axios

Bridge is designed as a drop-in replacement for axios:

```diff
- import axios from 'axios';
+ import bridge from 'bridge';

- const api = axios.create({ baseURL: 'https://api.example.com' });
+ const api = bridge.create({ baseURL: 'https://api.example.com' });

// Everything else stays the same!
const { data } = await api.get('/users');
```

### Compatibility

| Feature | Axios | Bridge |
|---------|-------|--------|
| `get/post/put/patch/delete/head/options` | ✅ | ✅ |
| Request/Response interceptors | ✅ | ✅ |
| `create()` instances | ✅ | ✅ |
| Auto JSON transform | ✅ | ✅ |
| Query params serialization | ✅ | ✅ |
| Timeout support | ✅ | ✅ |
| AbortController | ✅ | ✅ |
| CancelToken | ✅ | ✅ |
| `isAxiosError()` compat | ✅ | ✅ |
| Redirect following | ✅ | ✅ |
| Basic auth | ✅ | ✅ |
| Automatic retry | ❌ | ✅ |
| Certificate pinning | ❌ | ✅ |
| Mutual TLS (mTLS) | ❌ | ✅ |
| Request/Response transformers | ❌ | ✅ |
| Request ID tracking | ❌ | ✅ |
| SSRF protection | ❌ | ✅ |
| DNS rebinding protection | ❌ | ✅ |
| HTTPS enforcement | ❌ | ✅ |
| Header injection prevention | ❌ | ✅ |
| URL credential blocking | ❌ | ✅ |
| Response timeout | ❌ | ✅ |
| Zero dependencies | ❌ | ✅ |
| Protocol validation | ❌ | ✅ |
| Header sanitization | ❌ | ✅ |
| Content size limits | ❌ | ✅ |
| TLS version enforcement | ❌ | ✅ |
| Custom cipher suites | ❌ | ✅ |
| Rate limiting | ❌ | ✅ |
| Circuit breaker | ❌ | ✅ |
| Concurrency control | ❌ | ✅ |
| Progress events | ❌ | ✅ |
| Request timeline/metrics | ❌ | ✅ |
| Event hooks | ❌ | ✅ |
| Domain allowlist/blocklist | ❌ | ✅ |
| Sensitive header stripping on redirects | ❌ | ✅ |
| HTTPS downgrade protection | ❌ | ✅ |

## 📄 License

MIT
