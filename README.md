# 🌉 Bridge

**A powerful, secure, and lightning-fast HTTP client for Node.js.**

Bridge is a zero-dependency HTTP client with an axios-compatible API. Drop-in replacement with enhanced security features, automatic compression, and full TypeScript support.

## ✨ Features

- **🔄 Axios-compatible API** — familiar `get`, `post`, `put`, `patch`, `delete`, `head`, `options` methods
- **🔒 Security-first** — SSRF protection, URL validation, header sanitization, content size limits
- **⚡ Zero dependencies** — built on Node.js `http`/`https` modules only
- **📦 Auto JSON** — automatic request serialization and response parsing
- **🗜️ Decompression** — automatic gzip, deflate, and brotli decompression
- **🔀 Interceptors** — request and response interceptors (axios-style)
- **⏱️ Timeouts** — configurable request timeouts
- **🔁 Redirects** — automatic redirect following with configurable limits
- **❌ Cancellation** — AbortController and CancelToken support
- **📝 TypeScript** — full type definitions included

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
  responseType: 'json',        // 'json' | 'text' | 'arraybuffer' | 'stream'
  maxContentLength: 50 * 1024 * 1024,
  maxBodyLength: 50 * 1024 * 1024,
  maxRedirects: 5,
  validateStatus: (status) => status >= 200 && status < 300,
  auth: { username: 'user', password: 'pass' },
  decompress: true,
  signal: controller.signal,

  // Security
  allowPrivateNetworks: false,  // SSRF protection
  maxHeaderSize: 16384,
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

### Protocol Validation

Only `http:` and `https:` protocols are allowed. Attempts to use `file:`, `ftp:`, or other protocols are blocked.

### Content Size Limits

Configurable limits on both request body and response size to prevent memory exhaustion:

```typescript
const res = await bridge.get('/large-file', {
  maxContentLength: 10 * 1024 * 1024, // 10 MB max response
  maxBodyLength: 5 * 1024 * 1024,     // 5 MB max request body
});
```

### Header Sanitization

Dangerous headers (`Host`, `Connection`) are automatically stripped from user-provided headers.

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
| SSRF protection | ❌ | ✅ |
| Zero dependencies | ❌ | ✅ |
| Protocol validation | ❌ | ✅ |
| Header sanitization | ❌ | ✅ |
| Content size limits | ❌ | ✅ |

## 📄 License

MIT
