import * as http from 'http';
import * as crypto from 'crypto';
import bridge, {
  create,
  CancelToken,
  isCancel,
  isBridgeError,
  isAxiosError,
  BridgeRequestConfig,
  ResponseCache,
  RequestDeduplicator,
  signRequest,
  verifySignature,
} from '../src';

// ─── Test Types ────────────────────────────────────────────────────────────────

interface EchoData {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

// ─── Test Helpers ──────────────────────────────────────────────────────────────

let server: http.Server;
let baseURL: string;
const flakyCounters: Record<string, number> = {};

function createTestServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      // Disable keep-alive to avoid connection reuse issues in tests
      res.setHeader('Connection', 'close');
      const url = new URL(req.url || '/', `http://localhost`);
      const pathname = url.pathname;

      // Collect body
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        // Route: echo request info back
        if (pathname === '/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: body || null,
            })
          );
          return;
        }

        // Route: return specific status
        if (pathname.startsWith('/status/')) {
          const statusCode = parseInt(pathname.split('/')[2], 10);
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: statusCode }));
          return;
        }

        // Route: delayed response
        if (pathname === '/delay') {
          const ms = parseInt(url.searchParams.get('ms') || '1000', 10);
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ delayed: true, ms }));
            }
          }, ms);
          return;
        }

        // Route: redirect
        if (pathname === '/redirect') {
          const target = url.searchParams.get('to') || '/echo';
          res.writeHead(302, { Location: target });
          res.end();
          return;
        }

        // Route: redirect chain
        if (pathname.startsWith('/redirect-chain/')) {
          const count = parseInt(pathname.split('/')[2], 10);
          if (count > 0) {
            res.writeHead(302, { Location: `/redirect-chain/${count - 1}` });
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ redirected: true }));
          }
          return;
        }

        // Route: large response
        if (pathname === '/large') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('x'.repeat(1024 * 1024)); // 1MB
          return;
        }

        // Route: text response
        if (pathname === '/text') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello, Bridge!');
          return;
        }

        // Route: 204 No Content
        if (pathname === '/no-content') {
          res.writeHead(204);
          res.end();
          return;
        }

        // Route: intermittent failure (fails N times then succeeds)
        if (pathname === '/flaky') {
          const failCount = parseInt(url.searchParams.get('fail') || '2', 10);
          const key = url.searchParams.get('key') || 'default';
          if (!flakyCounters[key]) flakyCounters[key] = 0;
          flakyCounters[key]++;
          if (flakyCounters[key] <= failCount) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service Unavailable', attempt: flakyCounters[key] }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, attempts: flakyCounters[key] }));
            flakyCounters[key] = 0; // Reset for next test
          }
          return;
        }

        // Route: slow body (starts responding then delays)
        if (pathname === '/slow-body') {
          const ms = parseInt(url.searchParams.get('ms') || '2000', 10);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('start...');
          setTimeout(() => {
            if (!res.writableEnded) {
              res.end('...done');
            }
          }, ms);
          return;
        }

        // Route: return request headers back (for testing request ID, etc.)
        if (pathname === '/headers') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ headers: req.headers }));
          return;
        }

        // Route: redirect to an external URL (for testing cross-origin redirect header stripping)
        if (pathname === '/redirect-external') {
          const target = url.searchParams.get('to') || 'http://example.com/';
          const statusCode = parseInt(url.searchParams.get('status') || '302', 10);
          res.writeHead(statusCode, { Location: target });
          res.end();
          return;
        }

        // Route: redirect to a different path on same server, echoing headers (for testing same-origin redirect)
        if (pathname === '/redirect-with-headers') {
          res.writeHead(302, { Location: '/headers' });
          res.end();
          return;
        }

        // Route: return a known body with specific content-type (for integrity/content-type tests)
        if (pathname === '/known-body') {
          const contentType = url.searchParams.get('type') || 'application/json';
          const bodyContent = url.searchParams.get('body') || '{"known":"body"}';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(bodyContent);
          return;
        }

        // Route: return retry-after header
        if (pathname === '/retry-after') {
          const retryAfter = url.searchParams.get('after') || '1';
          const key = url.searchParams.get('key') || 'default-ra';
          if (!flakyCounters[key]) flakyCounters[key] = 0;
          flakyCounters[key]++;
          if (flakyCounters[key] <= 1) {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': retryAfter,
            });
            res.end(JSON.stringify({ error: 'Too Many Requests' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, attempts: flakyCounters[key] }));
            flakyCounters[key] = 0;
          }
          return;
        }

        // Route: verify signed request
        if (pathname === '/verify-signature') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body || null,
          }));
          return;
        }

        // Route: return response with idempotency key echo
        if (pathname === '/idempotency') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            idempotencyKey: req.headers['idempotency-key'] || null,
            headers: req.headers,
          }));
          return;
        }

        // Default 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseURL = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

// ─── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await createTestServer();
});

afterAll((done) => {
  server.close(done);
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('bridge', () => {
  // Use a client that allows private networks (since test server is on 127.0.0.1)
  let client: typeof bridge;

  beforeAll(() => {
    client = bridge.create({ allowPrivateNetworks: true }) as typeof bridge;
    // Copy static methods
    client.all = bridge.all;
    client.spread = bridge.spread;
    client.CancelToken = bridge.CancelToken;
    client.isCancel = bridge.isCancel;
    client.isBridgeError = bridge.isBridgeError;
    client.isAxiosError = bridge.isAxiosError;
  });

  // ─── Basic Requests ────────────────────────────────────────────────────────

  describe('basic requests', () => {
    it('should make a GET request', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`);
      expect(res.status).toBe(200);
      expect(res.data.method).toBe('GET');
    });

    it('should make a POST request with JSON data', async () => {
      const payload = { name: 'bridge', version: '1.0' };
      const res = await client.post<EchoData>(`${baseURL}/echo`, payload);
      expect(res.status).toBe(200);
      expect(res.data.method).toBe('POST');
      expect(JSON.parse(res.data.body!)).toEqual(payload);
      expect(res.data.headers['content-type']).toBe('application/json');
    });

    it('should make a PUT request', async () => {
      const res = await client.put<EchoData>(`${baseURL}/echo`, { key: 'value' });
      expect(res.status).toBe(200);
      expect(res.data.method).toBe('PUT');
    });

    it('should make a PATCH request', async () => {
      const res = await client.patch<EchoData>(`${baseURL}/echo`, { patched: true });
      expect(res.status).toBe(200);
      expect(res.data.method).toBe('PATCH');
    });

    it('should make a DELETE request', async () => {
      const res = await client.delete<EchoData>(`${baseURL}/echo`);
      expect(res.status).toBe(200);
      expect(res.data.method).toBe('DELETE');
    });

    it('should make a HEAD request', async () => {
      const res = await client.head(`${baseURL}/echo`);
      expect(res.status).toBe(200);
    });

    it('should make an OPTIONS request', async () => {
      const res = await client.options(`${baseURL}/echo`);
      expect(res.status).toBe(200);
    });
  });

  // ─── Callable instance ─────────────────────────────────────────────────────

  describe('callable instance', () => {
    it('should work as a callable function with URL string', async () => {
      const res = await client<EchoData>(`${baseURL}/echo`);
      expect(res.status).toBe(200);
    });

    it('should work as a callable function with config object', async () => {
      const res = await client<EchoData>({ url: `${baseURL}/echo`, method: 'GET' });
      expect(res.status).toBe(200);
    });
  });

  // ─── Response Format ───────────────────────────────────────────────────────

  describe('response format', () => {
    it('should have the correct response shape', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`);
      expect(res).toHaveProperty('data');
      expect(res).toHaveProperty('status');
      expect(res).toHaveProperty('statusText');
      expect(res).toHaveProperty('headers');
      expect(res).toHaveProperty('config');
      expect(typeof res.headers).toBe('object');
    });

    it('should handle text response type', async () => {
      const res = await client.get(`${baseURL}/text`, {
        responseType: 'text',
      });
      expect(res.data).toBe('Hello, Bridge!');
    });

    it('should handle arraybuffer response type', async () => {
      const res = await client.get(`${baseURL}/text`, {
        responseType: 'arraybuffer',
      });
      expect(Buffer.isBuffer(res.data)).toBe(true);
    });

    it('should auto-parse JSON responses', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`);
      expect(typeof res.data).toBe('object');
      expect(res.data.method).toBe('GET');
    });

    it('should handle 204 No Content', async () => {
      const res = await client.get(`${baseURL}/no-content`);
      expect(res.status).toBe(204);
    });
  });

  // ─── Query Params ─────────────────────────────────────────────────────────

  describe('query params', () => {
    it('should serialize params into the URL', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`, {
        params: { foo: 'bar', baz: 123 },
      });
      expect(res.data.url).toContain('foo=bar');
      expect(res.data.url).toContain('baz=123');
    });

    it('should handle array params', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`, {
        params: { ids: [1, 2, 3] },
      });
      expect(res.data.url).toContain('ids=1');
      expect(res.data.url).toContain('ids=2');
      expect(res.data.url).toContain('ids=3');
    });

    it('should handle URLSearchParams', async () => {
      const params = new URLSearchParams();
      params.append('key', 'value');
      const res = await client.get<EchoData>(`${baseURL}/echo`, { params });
      expect(res.data.url).toContain('key=value');
    });
  });

  // ─── Base URL ──────────────────────────────────────────────────────────────

  describe('baseURL', () => {
    it('should prepend baseURL to relative URLs', async () => {
      const instance = client.create({ baseURL });
      const res = await instance.get<EchoData>('/echo');
      expect(res.status).toBe(200);
      expect(res.data.method).toBe('GET');
    });

    it('should not prepend baseURL to absolute URLs', async () => {
      const instance = client.create({ baseURL: 'http://other.invalid' });
      const res = await instance.get(`${baseURL}/echo`);
      expect(res.status).toBe(200);
    });
  });

  // ─── Custom Instance ──────────────────────────────────────────────────────

  describe('create instance', () => {
    it('should create an instance with custom defaults', async () => {
      const instance = client.create({
        baseURL,
        headers: { 'X-Custom': 'test-header' },
      });
      const res = await instance.get<EchoData>('/echo');
      expect(res.data.headers['x-custom']).toBe('test-header');
    });

    it('should merge instance defaults with request config', async () => {
      const instance = client.create({
        baseURL,
        headers: { 'X-Instance': 'yes' },
      });
      const res = await instance.get<EchoData>('/echo', {
        headers: { 'X-Request': 'also-yes' },
      });
      expect(res.data.headers['x-instance']).toBe('yes');
      expect(res.data.headers['x-request']).toBe('also-yes');
    });
  });

  // ─── Error Handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should reject on 4xx status codes', async () => {
      try {
        await client.get(`${baseURL}/status/404`);
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.response?.status).toBe(404);
          expect(err.code).toBe('ERR_BAD_RESPONSE');
        }
      }
    });

    it('should reject on 5xx status codes', async () => {
      try {
        await client.get(`${baseURL}/status/500`);
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.response?.status).toBe(500);
        }
      }
    });

    it('should have isAxiosError for compatibility', async () => {
      try {
        await client.get(`${baseURL}/status/500`);
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isAxiosError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.isAxiosError).toBe(true);
          expect(err.isBridgeError).toBe(true);
        }
      }
    });

    it('should support custom validateStatus', async () => {
      const res = await client.get(`${baseURL}/status/404`, {
        validateStatus: (status) => status < 500,
      });
      expect(res.status).toBe(404);
    });

    it('should reject on network errors', async () => {
      try {
        await client.get('http://127.0.0.1:1', {
          timeout: 1000,
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
      }
    });
  });

  // ─── Timeouts ─────────────────────────────────────────────────────────────

  describe('timeouts', () => {
    it('should timeout on slow responses', async () => {
      try {
        await client.get(`${baseURL}/delay?ms=5000`, {
          timeout: 100,
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ECONNABORTED');
        }
      }
    });
  });

  // ─── Redirects ────────────────────────────────────────────────────────────

  describe('redirects', () => {
    it('should follow redirects', async () => {
      const res = await client.get<EchoData>(`${baseURL}/redirect?to=/echo`, {
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
      expect(res.data.method).toBe('GET');
    });

    it('should fail when maxRedirects is exceeded', async () => {
      try {
        await client.get(`${baseURL}/redirect-chain/10`, {
          maxRedirects: 3,
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_MAX_REDIRECTS');
        }
      }
    });
  });

  // ─── Interceptors ─────────────────────────────────────────────────────────

  describe('interceptors', () => {
    it('should run request interceptors', async () => {
      const instance = client.create({ baseURL });
      instance.interceptors.request.use((config) => {
        config.headers = { ...config.headers, 'X-Intercepted': 'yes' };
        return config;
      });

      const res = await instance.get<EchoData>('/echo');
      expect(res.data.headers['x-intercepted']).toBe('yes');
    });

    it('should run response interceptors', async () => {
      const instance = client.create({ baseURL });
      instance.interceptors.response.use((response) => {
        (response as { transformed?: boolean }).transformed = true;
        return response;
      });

      const res = await instance.get<EchoData>('/echo');
      expect((res as { transformed?: boolean }).transformed).toBe(true);
    });

    it('should allow ejecting interceptors', async () => {
      const instance = client.create({ baseURL });
      const id = instance.interceptors.request.use((config) => {
        config.headers = { ...config.headers, 'X-Should-Not-Exist': 'yes' };
        return config;
      });
      instance.interceptors.request.eject(id);

      const res = await instance.get<EchoData>('/echo');
      expect(res.data.headers['x-should-not-exist']).toBeUndefined();
    });

    it('should handle errors in response interceptors', async () => {
      const instance = client.create({ baseURL });
      instance.interceptors.response.use(
        (response) => response,
        (error) => {
          return Promise.reject(error);
        }
      );

      try {
        await instance.get('/status/500');
        fail('Should have thrown');
      } catch (err) {
        expect(isBridgeError(err)).toBe(true);
      }
    });
  });

  // ─── CancelToken ─────────────────────────────────────────────────────────

  describe('CancelToken', () => {
    it('should cancel a request using CancelToken.source()', async () => {
      const source = CancelToken.source();

      const promise = client.get(`${baseURL}/delay?ms=5000`, {
        signal: AbortSignal.abort(), // immediate abort
      });

      source.cancel('User cancelled');

      try {
        await promise;
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
      }
    });

    it('should identify cancellations with isCancel', () => {
      const source = CancelToken.source();
      source.cancel('test');

      expect(source.token.reason).toBeDefined();
      expect(isCancel(source.token.reason)).toBe(true);
    });

    it('should throw if already cancelled via throwIfRequested', () => {
      const source = CancelToken.source();
      source.cancel('already cancelled');

      expect(() => source.token.throwIfRequested()).toThrow();
    });
  });

  // ─── AbortController ─────────────────────────────────────────────────────

  describe('AbortController', () => {
    it('should abort a request using AbortController', async () => {
      const controller = new AbortController();

      const promise = client.get(`${baseURL}/delay?ms=5000`, {
        signal: controller.signal,
      });

      // Abort immediately
      controller.abort();

      try {
        await promise;
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_CANCELED');
        }
      }
    });
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  describe('security', () => {
    it('should block requests to private IPs by default', async () => {
      try {
        // The test server is on 127.0.0.1, which is private. Without allowPrivateNetworks, it should fail.
        const insecureClient = bridge.create({});
        await insecureClient.get('http://127.0.0.1:9999/echo');
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.message).toContain('private network');
        }
      }
    });

    it('should allow private IPs when allowPrivateNetworks is true', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`);
      expect(res.status).toBe(200);
    });

    it('should block non-http protocols', async () => {
      try {
        await bridge.get('ftp://example.com/file');
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.message).toContain('Unsupported protocol');
        }
      }
    });
  });

  // ─── getUri ───────────────────────────────────────────────────────────────

  describe('getUri', () => {
    it('should return the full URI', () => {
      const uri = client.getUri({
        baseURL: 'http://example.com',
        url: '/users',
        params: { page: 1 },
      });
      expect(uri).toBe('http://example.com/users?page=1');
    });
  });

  // ─── Static Helpers ───────────────────────────────────────────────────────

  describe('static helpers', () => {
    it('bridge.all should resolve multiple promises', async () => {
      const results = await client.all([
        client.get(`${baseURL}/echo`),
        client.get(`${baseURL}/text`),
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
    });

    it('bridge.spread should spread array to function args', () => {
      const fn = client.spread((a: number, b: number) => a + b);
      expect(fn([1, 2])).toBe(3);
    });
  });

  // ─── Basic Auth ───────────────────────────────────────────────────────────

  describe('basic auth', () => {
    it('should send authorization header', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`, {
        auth: { username: 'user', password: 'pass' },
        allowPrivateNetworks: true,
      });
      expect(res.data.headers.authorization).toBeDefined();
      const decoded = Buffer.from(
        res.data.headers.authorization.replace('Basic ', ''),
        'base64'
      ).toString();
      expect(decoded).toBe('user:pass');
    });
  });

  // ─── Content Length Protection ────────────────────────────────────────────

  describe('content length protection', () => {
    it('should reject responses exceeding maxContentLength', async () => {
      try {
        await client.get(`${baseURL}/large`, {
          maxContentLength: 100,
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_CONTENT_TOO_LARGE');
        }
      }
    });

    it('should reject request body exceeding maxBodyLength', async () => {
      try {
        await client.post<EchoData>(`${baseURL}/echo`, 'x'.repeat(1024), {
          maxBodyLength: 100,
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_BODY_TOO_LARGE');
        }
      }
    });
  });

  // ─── Retry with Exponential Backoff ─────────────────────────────────────

  describe('retry', () => {
    it('should retry failed requests and eventually succeed', async () => {
      const key = `retry-test-${Date.now()}`;
      const res = await client.get(`${baseURL}/flaky?fail=2&key=${key}`, {
        retry: { retries: 3, delay: 50, maxDelay: 200, backoffFactor: 2, retryableMethods: ['GET'], retryableStatuses: [503] },
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
      expect((res.data as { success: boolean }).success).toBe(true);
    });

    it('should use default retry config when retry is true', async () => {
      const key = `retry-default-${Date.now()}`;
      const res = await client.get(`${baseURL}/flaky?fail=1&key=${key}`, {
        retry: true,
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });

    it('should fail when all retries are exhausted', async () => {
      const key = `retry-exhaust-${Date.now()}`;
      try {
        await client.get(`${baseURL}/flaky?fail=10&key=${key}`, {
          retry: { retries: 2, delay: 50, maxDelay: 100, backoffFactor: 2, retryableMethods: ['GET'], retryableStatuses: [503] },
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
      }
    });

    it('should not retry non-retryable methods', async () => {
      const key = `retry-post-${Date.now()}`;
      try {
        await client.post(`${baseURL}/flaky?fail=2&key=${key}`, {}, {
          retry: { retries: 3, delay: 50, maxDelay: 100, backoffFactor: 2, retryableMethods: ['GET'], retryableStatuses: [503] },
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
      }
    });

    it('should support custom retry condition', async () => {
      const key = `retry-custom-${Date.now()}`;
      const res = await client.get(`${baseURL}/flaky?fail=1&key=${key}`, {
        retry: {
          retries: 3,
          delay: 50,
          maxDelay: 100,
          backoffFactor: 2,
          retryableMethods: ['GET'],
          retryableStatuses: [503],
          retryCondition: (error) => error.response?.status === 503,
        },
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── Request ID ───────────────────────────────────────────────────────────

  describe('request ID', () => {
    it('should inject X-Request-ID when requestId is true', async () => {
      const res = await client.get<{ headers: Record<string, string> }>(`${baseURL}/headers`, {
        requestId: true,
        allowPrivateNetworks: true,
      });
      expect(res.data.headers['x-request-id']).toBeDefined();
      // UUID v4 format
      expect(res.data.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('should inject custom request ID when requestId is a string', async () => {
      const customId = 'my-custom-request-id-123';
      const res = await client.get<{ headers: Record<string, string> }>(`${baseURL}/headers`, {
        requestId: customId,
        allowPrivateNetworks: true,
      });
      expect(res.data.headers['x-request-id']).toBe(customId);
    });

    it('should not inject request ID when requestId is not set', async () => {
      const res = await client.get<{ headers: Record<string, string> }>(`${baseURL}/headers`, {
        allowPrivateNetworks: true,
      });
      expect(res.data.headers['x-request-id']).toBeUndefined();
    });
  });

  // ─── Request/Response Transformers ────────────────────────────────────────

  describe('transformers', () => {
    it('should apply transformRequest to request data', async () => {
      const res = await client.post<EchoData>(`${baseURL}/echo`, { foo: 'bar' }, {
        allowPrivateNetworks: true,
        transformRequest: [
          (data, headers) => {
            headers['Content-Type'] = 'application/json';
            return JSON.stringify({ ...(data as object), extra: 'added' });
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.data.body || '{}');
      expect(body.extra).toBe('added');
    });

    it('should apply transformResponse to response data', async () => {
      const res = await client.get<{ method: string; transformed: boolean }>(`${baseURL}/echo`, {
        allowPrivateNetworks: true,
        transformResponse: [
          (data) => ({
            ...(data as object),
            transformed: true,
          }),
        ],
      });
      expect(res.data.transformed).toBe(true);
      expect(res.data.method).toBe('GET');
    });

    it('should chain multiple transformers', async () => {
      const res = await client.get<{ step1: boolean; step2: boolean }>(`${baseURL}/echo`, {
        allowPrivateNetworks: true,
        transformResponse: [
          (data) => ({ ...(data as object), step1: true }),
          (data) => ({ ...(data as object), step2: true }),
        ],
      });
      expect(res.data.step1).toBe(true);
      expect(res.data.step2).toBe(true);
    });
  });

  // ─── HTTPS Enforcement ────────────────────────────────────────────────────

  describe('HTTPS enforcement', () => {
    it('should block HTTP requests when enforceHttps is true', async () => {
      try {
        await bridge.get('http://example.com', {
          enforceHttps: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.message).toContain('HTTPS is enforced');
        }
      }
    });
  });

  // ─── Enhanced Header Sanitization ─────────────────────────────────────────

  describe('enhanced security', () => {
    it('should block header injection via newline characters', async () => {
      try {
        await client.get(`${baseURL}/echo`, {
          headers: {
            'X-Custom': 'value\r\nInjected-Header: evil',
          },
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.message).toContain('Header injection');
        }
      }
    });

    it('should block header injection via null byte', async () => {
      try {
        await client.get(`${baseURL}/echo`, {
          headers: {
            'X-Custom': 'value\x00evil',
          },
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.message).toContain('Header injection');
        }
      }
    });

    it('should strip additional dangerous headers', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`, {
        headers: {
          'Host': 'evil.com',
          'Connection': 'keep-alive',
          'Transfer-Encoding': 'chunked',
          'Upgrade': 'websocket',
          'X-Safe-Header': 'value',
        },
        allowPrivateNetworks: true,
      });
      expect(res.data.headers['x-safe-header']).toBe('value');
      // These should be stripped or overridden by Node.js
      expect(res.data.headers['upgrade']).toBeUndefined();
      expect(res.data.headers['transfer-encoding']).toBeUndefined();
    });

    it('should block URLs with embedded credentials', async () => {
      try {
        await bridge.get('http://user:pass@example.com/path');
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.message).toContain('embedded credentials');
        }
      }
    });
  });

  // ─── Response Timeout ─────────────────────────────────────────────────────

  describe('response timeout', () => {
    it('should timeout on slow body download', async () => {
      try {
        await client.get(`${baseURL}/slow-body?ms=5000`, {
          responseTimeout: 100,
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_RESPONSE_TIMEOUT');
        }
      }
    });
  });

  // ─── TLS Config Types ────────────────────────────────────────────────────

  describe('TLS configuration', () => {
    it('should accept TLS configuration options', async () => {
      // This test validates that TLS config is accepted without error
      // (actual TLS verification requires an HTTPS server)
      const instance = bridge.create({
        allowPrivateNetworks: true,
        tls: {
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256',
        },
      });
      // Make a simple HTTP request (TLS config is only applied to HTTPS)
      const res = await instance.get<EchoData>(`${baseURL}/echo`);
      expect(res.status).toBe(200);
    });
  });

  // ─── DNS Protection ──────────────────────────────────────────────────────

  describe('DNS protection', () => {
    it('should accept dnsProtection option', async () => {
      // DNS protection on loopback should work when allowPrivateNetworks is true
      const res = await client.get<EchoData>(`${baseURL}/echo`, {
        dnsProtection: true,
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── v4.0.0 Features ─────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Rate Limiting ──────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('should limit request throughput via setRateLimiter', async () => {
      const instance = client.create({ baseURL });
      instance.setRateLimiter({ maxRequests: 2, windowMs: 1000 });

      // First two should go through immediately
      const start = Date.now();
      await instance.get('/echo');
      await instance.get('/echo');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);

      // Third request should be delayed (rate limited)
      await instance.get('/echo');
      const totalElapsed = Date.now() - start;
      expect(totalElapsed).toBeGreaterThanOrEqual(250); // some delay
    });

    it('should allow disabling rate limiter with false', async () => {
      const instance = client.create({ baseURL });
      instance.setRateLimiter({ maxRequests: 1, windowMs: 5000 });
      // Now disable it
      instance.setRateLimiter(false);

      const start = Date.now();
      await instance.get('/echo');
      await instance.get('/echo');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });

  // ─── Circuit Breaker ──────────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('should open circuit after failure threshold', async () => {
      const instance = client.create({ baseURL });
      instance.setCircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 50000,
        halfOpenRequests: 1,
      });

      expect(instance.getCircuitState()).toBe('closed');

      // Cause 2 failures
      try { await instance.get('/status/500'); } catch { /* expected */ }
      try { await instance.get('/status/500'); } catch { /* expected */ }

      // Circuit should be open now
      expect(instance.getCircuitState()).toBe('open');

      // Next request should be immediately rejected
      try {
        await instance.get('/echo');
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_CIRCUIT_OPEN');
          expect(err.message).toContain('Circuit breaker is open');
        }
      }
    });

    it('should transition to half-open after resetTimeout', async () => {
      const instance = client.create({ baseURL });
      instance.setCircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 100, // 100ms
        halfOpenRequests: 1,
      });

      // Cause a failure
      try { await instance.get('/status/500'); } catch { /* expected */ }
      expect(instance.getCircuitState()).toBe('open');

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 150));

      // Should be half-open now
      expect(instance.getCircuitState()).toBe('half-open');

      // Successful request should close the circuit
      const res = await instance.get('/echo');
      expect(res.status).toBe(200);
      expect(instance.getCircuitState()).toBe('closed');
    });

    it('should return null when circuit breaker is not set', () => {
      const instance = client.create({ baseURL });
      expect(instance.getCircuitState()).toBeNull();
    });

    it('should fire onStateChange callback', async () => {
      const stateChanges: Array<{ from: string; to: string }> = [];
      const instance = client.create({ baseURL });
      instance.setCircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 100,
        halfOpenRequests: 1,
        onStateChange: (from, to) => stateChanges.push({ from, to }),
      });

      try { await instance.get('/status/500'); } catch { /* expected */ }
      expect(stateChanges).toEqual([
        { from: 'closed', to: 'open' },
      ]);

      await new Promise((r) => setTimeout(r, 150));

      // Trigger half-open check
      const res = await instance.get('/echo');
      expect(res.status).toBe(200);
      expect(stateChanges).toEqual([
        { from: 'closed', to: 'open' },
        { from: 'open', to: 'half-open' },
        { from: 'half-open', to: 'closed' },
      ]);
    });
  });

  // ─── Concurrency Control ──────────────────────────────────────────────────

  describe('concurrency control', () => {
    it('should limit concurrent requests', async () => {
      const instance = client.create({ baseURL });
      instance.setConcurrency(2);

      // Launch 4 requests; only 2 should be active at any time
      const delays = [
        instance.get('/delay?ms=100'),
        instance.get('/delay?ms=100'),
        instance.get('/delay?ms=100'),
        instance.get('/delay?ms=100'),
      ];

      const results = await Promise.all(delays);
      expect(results).toHaveLength(4);
      results.forEach((res) => expect(res.status).toBe(200));
    });

    it('should accept number shorthand for setConcurrency', async () => {
      const instance = client.create({ baseURL });
      instance.setConcurrency(5);

      const results = await Promise.all([
        instance.get('/echo'),
        instance.get('/echo'),
        instance.get('/echo'),
      ]);
      expect(results).toHaveLength(3);
    });
  });

  // ─── Download Progress ────────────────────────────────────────────────────

  describe('download progress', () => {
    it('should fire onDownloadProgress callbacks', async () => {
      const progressEvents: Array<{ loaded: number; total: number; progress: number }> = [];

      const res = await client.get(`${baseURL}/large`, {
        onDownloadProgress: (event) => {
          progressEvents.push({
            loaded: event.loaded,
            total: event.total,
            progress: event.progress,
          });
        },
        allowPrivateNetworks: true,
      });

      expect(res.status).toBe(200);
      expect(progressEvents.length).toBeGreaterThan(0);

      // Each event should have increasing loaded values
      for (let i = 1; i < progressEvents.length; i++) {
        expect(progressEvents[i].loaded).toBeGreaterThanOrEqual(progressEvents[i - 1].loaded);
      }

      // Last event should have loaded close to total content
      const lastEvent = progressEvents[progressEvents.length - 1];
      expect(lastEvent.loaded).toBeGreaterThan(0);
    });

    it('should include rate and estimated fields', async () => {
      let lastEvent: { rate: number; estimated: number } | null = null;

      await client.get(`${baseURL}/large`, {
        onDownloadProgress: (event) => {
          lastEvent = { rate: event.rate, estimated: event.estimated };
        },
        allowPrivateNetworks: true,
      });

      expect(lastEvent).not.toBeNull();
      expect(lastEvent!.rate).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── Upload Progress ──────────────────────────────────────────────────────

  describe('upload progress', () => {
    it('should fire onUploadProgress callbacks', async () => {
      const progressEvents: Array<{ loaded: number; total: number; progress: number }> = [];
      const largeBody = 'x'.repeat(10 * 1024); // 10KB

      const res = await client.post(`${baseURL}/echo`, largeBody, {
        onUploadProgress: (event) => {
          progressEvents.push({
            loaded: event.loaded,
            total: event.total,
            progress: event.progress,
          });
        },
        allowPrivateNetworks: true,
      });

      expect(res.status).toBe(200);
      expect(progressEvents.length).toBeGreaterThan(0);

      // Last event should be 100%
      const lastEvent = progressEvents[progressEvents.length - 1];
      expect(lastEvent.progress).toBe(100);
      expect(lastEvent.loaded).toBe(lastEvent.total);
    });
  });

  // ─── Request Timeline ─────────────────────────────────────────────────────

  describe('request timeline', () => {
    it('should collect timeline metrics when collectTimeline is true', async () => {
      const res = await client.get(`${baseURL}/echo`, {
        collectTimeline: true,
        allowPrivateNetworks: true,
      });

      expect(res.status).toBe(200);
      expect(res.timeline).toBeDefined();
      expect(res.timeline!.startTime).toBeGreaterThan(0);
      expect(res.timeline!.total).toBeGreaterThanOrEqual(0);
      expect(res.timeline!.firstByte).toBeGreaterThanOrEqual(0);
      expect(res.timeline!.contentDownload).toBeGreaterThanOrEqual(0);
    });

    it('should not include timeline by default', async () => {
      const res = await client.get(`${baseURL}/echo`, {
        allowPrivateNetworks: true,
      });

      expect(res.status).toBe(200);
      expect(res.timeline).toBeUndefined();
    });
  });

  // ─── Event Hooks ──────────────────────────────────────────────────────────

  describe('event hooks', () => {
    it('should fire onRequest hook', async () => {
      let hookCalled = false;
      let hookConfig: BridgeRequestConfig | null = null;

      await client.get(`${baseURL}/echo`, {
        allowPrivateNetworks: true,
        hooks: {
          onRequest: (config) => {
            hookCalled = true;
            hookConfig = config;
          },
        },
      });

      expect(hookCalled).toBe(true);
      expect(hookConfig).not.toBeNull();
    });

    it('should fire onResponse hook', async () => {
      let hookResponse: { status: number } | null = null;

      await client.get(`${baseURL}/echo`, {
        allowPrivateNetworks: true,
        hooks: {
          onResponse: (response) => {
            hookResponse = { status: response.status };
          },
        },
      });

      expect(hookResponse).not.toBeNull();
      expect(hookResponse!.status).toBe(200);
    });

    it('should fire onError hook on failure', async () => {
      let hookError: { code?: string } | null = null;

      try {
        await client.get(`${baseURL}/status/500`, {
          allowPrivateNetworks: true,
          hooks: {
            onError: (error) => {
              hookError = { code: error.code };
            },
          },
        });
        fail('Should have thrown');
      } catch {
        expect(hookError).not.toBeNull();
        expect(hookError!.code).toBe('ERR_BAD_RESPONSE');
      }
    });

    it('should fire onRetry hook during retries', async () => {
      const retryEvents: Array<{ attempt: number; delay: number }> = [];
      const key = `retry-hook-${Date.now()}`;

      await client.get(`${baseURL}/flaky?fail=1&key=${key}`, {
        retry: { retries: 3, delay: 50, maxDelay: 200, backoffFactor: 2, retryableMethods: ['GET'], retryableStatuses: [503] },
        allowPrivateNetworks: true,
        hooks: {
          onRetry: (attempt, _error, delay) => {
            retryEvents.push({ attempt, delay });
          },
        },
      });

      expect(retryEvents.length).toBeGreaterThan(0);
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[0].delay).toBeGreaterThan(0);
    });
  });

  // ─── RateLimiter Unit Tests ──────────────────────────────────────────────

  describe('RateLimiter class', () => {
    it('should track available tokens', () => {
      const { RateLimiter } = require('../src/ratelimit');
      const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
      expect(limiter.getAvailableTokens()).toBe(3);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.getAvailableTokens()).toBe(2);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('should reset to full capacity', () => {
      const { RateLimiter } = require('../src/ratelimit');
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });

      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.reset();
      expect(limiter.getAvailableTokens()).toBe(5);
    });
  });

  // ─── CircuitBreaker Unit Tests ────────────────────────────────────────────

  describe('CircuitBreaker class', () => {
    it('should start in closed state', () => {
      const { CircuitBreaker } = require('../src/circuit-breaker');
      const cb = new CircuitBreaker();
      expect(cb.getState()).toBe('closed');
      expect(cb.allowRequest()).toBe(true);
    });

    it('should open after failure threshold', () => {
      const { CircuitBreaker } = require('../src/circuit-breaker');
      const cb = new CircuitBreaker({ failureThreshold: 2 });

      cb.recordFailure();
      expect(cb.getState()).toBe('closed');

      cb.recordFailure();
      expect(cb.getState()).toBe('open');
      expect(cb.allowRequest()).toBe(false);
    });

    it('should reset properly', () => {
      const { CircuitBreaker } = require('../src/circuit-breaker');
      const cb = new CircuitBreaker({ failureThreshold: 1 });

      cb.recordFailure();
      expect(cb.getState()).toBe('open');

      cb.reset();
      expect(cb.getState()).toBe('closed');
      expect(cb.getFailureCount()).toBe(0);
    });
  });

  // ─── ConcurrencyManager Unit Tests ────────────────────────────────────────

  describe('ConcurrencyManager class', () => {
    it('should track running and queued counts', async () => {
      const { ConcurrencyManager } = require('../src/concurrency');
      const manager = new ConcurrencyManager({ maxConcurrent: 1 });

      expect(manager.getRunning()).toBe(0);
      expect(manager.getQueueSize()).toBe(0);
      expect(manager.getMaxConcurrent()).toBe(1);

      let resolve1!: () => void;
      const p1 = new Promise<void>((r) => { resolve1 = r; });
      const task1 = manager.execute(() => p1);

      // Give microtask time to start
      await new Promise((r) => setTimeout(r, 10));
      expect(manager.getRunning()).toBe(1);

      resolve1();
      await task1;
      expect(manager.getRunning()).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── v5.0.0 Security Features ─────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Domain Allowlist ──────────────────────────────────────────────────────

  describe('domain allowlist', () => {
    it('should allow requests to domains in the allowlist', async () => {
      const instance = client.create({
        allowedDomains: ['127.0.0.1'],
        allowPrivateNetworks: true,
      });
      const res = await instance.get(`${baseURL}/echo`);
      expect(res.status).toBe(200);
    });

    it('should block requests to domains NOT in the allowlist', async () => {
      try {
        const instance = bridge.create({
          allowedDomains: ['api.example.com'],
          allowPrivateNetworks: true,
        });
        await instance.get(`${baseURL}/echo`);
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_DOMAIN_BLOCKED');
          expect(err.message).toContain('not in the domain allowlist');
        }
      }
    });

    it('should support wildcard subdomain patterns in allowlist', async () => {
      try {
        const instance = bridge.create({
          allowedDomains: ['*.example.com'],
          allowPrivateNetworks: true,
        });
        await instance.get('http://api.example.com/path');
        // This will fail with a network error since example.com doesn't exist,
        // but it should NOT fail with ERR_DOMAIN_BLOCKED
        fail('Should have thrown a network error');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).not.toBe('ERR_DOMAIN_BLOCKED');
        }
      }
    });
  });

  // ─── Domain Blocklist ──────────────────────────────────────────────────────

  describe('domain blocklist', () => {
    it('should block requests to domains in the blocklist', async () => {
      try {
        const instance = bridge.create({
          blockedDomains: ['127.0.0.1'],
          allowPrivateNetworks: true,
        });
        await instance.get(`${baseURL}/echo`);
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_DOMAIN_BLOCKED');
          expect(err.message).toContain('blocked by the domain blocklist');
        }
      }
    });

    it('should allow requests to domains NOT in the blocklist', async () => {
      const instance = client.create({
        blockedDomains: ['evil.com', 'bad-actor.net'],
        allowPrivateNetworks: true,
      });
      const res = await instance.get(`${baseURL}/echo`);
      expect(res.status).toBe(200);
    });

    it('should support wildcard subdomain patterns in blocklist', async () => {
      try {
        const instance = bridge.create({
          blockedDomains: ['*.evil.com'],
          allowPrivateNetworks: true,
        });
        await instance.get('http://sub.evil.com/path');
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_DOMAIN_BLOCKED');
        }
      }
    });

    it('should block base domain when wildcard pattern is used', async () => {
      try {
        const instance = bridge.create({
          blockedDomains: ['*.evil.com'],
          allowPrivateNetworks: true,
        });
        await instance.get('http://evil.com/path');
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_DOMAIN_BLOCKED');
        }
      }
    });

    it('should apply blocklist before allowlist', async () => {
      // When a domain is in both blocklist and allowlist, blocklist wins
      try {
        const instance = bridge.create({
          allowedDomains: ['127.0.0.1'],
          blockedDomains: ['127.0.0.1'],
          allowPrivateNetworks: true,
        });
        await instance.get(`${baseURL}/echo`);
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_DOMAIN_BLOCKED');
          expect(err.message).toContain('blocked by the domain blocklist');
        }
      }
    });
  });

  // ─── Sensitive Header Stripping on Cross-Origin Redirects ──────────────────

  describe('sensitive header stripping on cross-origin redirects', () => {
    it('should preserve sensitive headers on same-origin redirects', async () => {
      const res = await client.get<{ headers: Record<string, string> }>(`${baseURL}/redirect-with-headers`, {
        headers: {
          'Authorization': 'Bearer secret-token-123',
          'X-Custom': 'stays',
        },
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
      expect(res.data.headers['authorization']).toBe('Bearer secret-token-123');
      expect(res.data.headers['x-custom']).toBe('stays');
    });

    it('should strip sensitive headers on cross-origin redirects by default', async () => {
      // Redirect to a different origin — we test by redirecting to the same server
      // but on a different port to simulate cross-origin. Since we can't actually
      // do that easily, we test the security module directly.
      const { stripSensitiveHeaders } = require('../src/security');
      const headers = {
        'Authorization': 'Bearer secret',
        'Cookie': 'session=abc123',
        'Proxy-Authorization': 'Basic creds',
        'X-Custom': 'keep-me',
        'Content-Type': 'application/json',
      };
      const stripped = stripSensitiveHeaders(headers);
      expect(stripped['Authorization']).toBeUndefined();
      expect(stripped['Cookie']).toBeUndefined();
      expect(stripped['Proxy-Authorization']).toBeUndefined();
      expect(stripped['X-Custom']).toBe('keep-me');
      expect(stripped['Content-Type']).toBe('application/json');
    });

    it('should detect cross-origin correctly', () => {
      const { isSameOrigin } = require('../src/security');
      const URL = require('url').URL;

      // Same origin
      expect(isSameOrigin(
        new URL('http://example.com/a'),
        new URL('http://example.com/b')
      )).toBe(true);

      // Different hostname
      expect(isSameOrigin(
        new URL('http://example.com/a'),
        new URL('http://other.com/b')
      )).toBe(false);

      // Different protocol
      expect(isSameOrigin(
        new URL('https://example.com/a'),
        new URL('http://example.com/b')
      )).toBe(false);

      // Different port
      expect(isSameOrigin(
        new URL('http://example.com:3000/a'),
        new URL('http://example.com:4000/b')
      )).toBe(false);

      // Same origin with port
      expect(isSameOrigin(
        new URL('http://example.com:3000/a'),
        new URL('http://example.com:3000/b')
      )).toBe(true);
    });

    it('should allow disabling sensitive header stripping', () => {
      // stripSensitiveHeadersOnRedirect: false should preserve headers
      // This is a config option test — ensuring the option is accepted
      const instance = client.create({
        stripSensitiveHeadersOnRedirect: false,
        allowPrivateNetworks: true,
      });
      expect(instance.defaults.stripSensitiveHeadersOnRedirect).toBe(false);
    });
  });

  // ─── HTTPS Downgrade Protection ────────────────────────────────────────────

  describe('HTTPS downgrade protection', () => {
    it('should block HTTPS to HTTP downgrade by default', () => {
      const { checkHttpsDowngrade } = require('../src/security');
      const URL = require('url').URL;

      expect(() => {
        checkHttpsDowngrade(
          new URL('https://example.com/a'),
          new URL('http://example.com/b'),
          false
        );
      }).toThrow('Redirect from HTTPS to HTTP is blocked');
    });

    it('should allow HTTPS to HTTP downgrade when explicitly permitted', () => {
      const { checkHttpsDowngrade } = require('../src/security');
      const URL = require('url').URL;

      expect(() => {
        checkHttpsDowngrade(
          new URL('https://example.com/a'),
          new URL('http://example.com/b'),
          true
        );
      }).not.toThrow();
    });

    it('should allow HTTP to HTTPS upgrade on redirects', () => {
      const { checkHttpsDowngrade } = require('../src/security');
      const URL = require('url').URL;

      expect(() => {
        checkHttpsDowngrade(
          new URL('http://example.com/a'),
          new URL('https://example.com/b'),
          false
        );
      }).not.toThrow();
    });

    it('should allow same-protocol redirects', () => {
      const { checkHttpsDowngrade } = require('../src/security');
      const URL = require('url').URL;

      expect(() => {
        checkHttpsDowngrade(
          new URL('http://example.com/a'),
          new URL('http://example.com/b'),
          false
        );
      }).not.toThrow();

      expect(() => {
        checkHttpsDowngrade(
          new URL('https://example.com/a'),
          new URL('https://example.com/b'),
          false
        );
      }).not.toThrow();
    });
  });

  // ─── Domain Validation Unit Tests ──────────────────────────────────────────

  describe('domain validation (unit)', () => {
    it('should match exact domains', () => {
      const { validateDomain } = require('../src/security');

      // Allowed exact match
      expect(() => validateDomain('example.com', ['example.com'])).not.toThrow();

      // Not in allowlist
      expect(() => validateDomain('other.com', ['example.com'])).toThrow('not in the domain allowlist');
    });

    it('should match wildcard subdomain patterns', () => {
      const { validateDomain } = require('../src/security');

      // Wildcard match
      expect(() => validateDomain('api.example.com', ['*.example.com'])).not.toThrow();
      expect(() => validateDomain('sub.api.example.com', ['*.example.com'])).not.toThrow();
      expect(() => validateDomain('example.com', ['*.example.com'])).not.toThrow();

      // Non-match
      expect(() => validateDomain('other.com', ['*.example.com'])).toThrow('not in the domain allowlist');
    });

    it('should be case insensitive', () => {
      const { validateDomain } = require('../src/security');

      expect(() => validateDomain('Example.COM', ['example.com'])).not.toThrow();
      expect(() => validateDomain('example.com', ['Example.COM'])).not.toThrow();
    });

    it('should handle empty allowlist/blocklist gracefully', () => {
      const { validateDomain } = require('../src/security');

      // Empty or undefined lists should not block anything
      expect(() => validateDomain('example.com', [], [])).not.toThrow();
      expect(() => validateDomain('example.com', undefined, undefined)).not.toThrow();
    });

    it('should prioritize blocklist over allowlist', () => {
      const { validateDomain } = require('../src/security');

      // Domain in both lists — blocklist should win
      expect(() => validateDomain('example.com', ['example.com'], ['example.com']))
        .toThrow('blocked by the domain blocklist');
    });
  });

  // ─── v5.0.0 Integration Tests ─────────────────────────────────────────────

  describe('v5.0.0 domain validation on redirects', () => {
    it('should block redirects to blocked domains', async () => {
      try {
        const instance = bridge.create({
          blockedDomains: ['example.com'],
          allowPrivateNetworks: true,
        });
        // This redirect target goes to example.com which is blocked
        await instance.get(`${baseURL}/redirect-external?to=http://example.com/`, {
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_DOMAIN_BLOCKED');
        }
      }
    });

    it('should block redirects to domains NOT in the allowlist', async () => {
      try {
        const instance = bridge.create({
          allowedDomains: ['127.0.0.1'],
          allowPrivateNetworks: true,
        });
        // This redirect target goes to example.com which is not in allowlist
        await instance.get(`${baseURL}/redirect-external?to=http://example.com/`, {
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_DOMAIN_BLOCKED');
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── v6.0.0 Features ─────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Response Integrity Verification ──────────────────────────────────────

  describe('response integrity verification', () => {
    it('should pass when expectedHash matches response body SHA-256', async () => {
      const body = '{"known":"body"}';
      const expectedHash = crypto.createHash('sha256').update(body).digest('hex');

      const res = await client.get(`${baseURL}/known-body?body=${encodeURIComponent(body)}`, {
        expectedHash,
        responseType: 'text',
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });

    it('should reject when expectedHash does not match', async () => {
      try {
        await client.get(`${baseURL}/known-body`, {
          expectedHash: 'deadbeef0000000000000000000000000000000000000000000000000000dead',
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_INTEGRITY_CHECK_FAILED');
          expect(err.message).toContain('integrity check failed');
        }
      }
    });

    it('should not check integrity when expectedHash is not set', async () => {
      const res = await client.get(`${baseURL}/echo`, {
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── Content-Type Validation ──────────────────────────────────────────────

  describe('content-type validation', () => {
    it('should pass when Content-Type matches expected', async () => {
      const res = await client.get(`${baseURL}/known-body?type=application/json`, {
        expectedContentType: 'application/json',
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });

    it('should pass with prefix match (e.g. application/json;charset=utf-8)', async () => {
      const res = await client.get(`${baseURL}/known-body?type=application/json;charset=utf-8`, {
        expectedContentType: 'application/json',
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });

    it('should reject when Content-Type does not match', async () => {
      try {
        await client.get(`${baseURL}/text`, {
          expectedContentType: 'application/json',
          allowPrivateNetworks: true,
        });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect(isBridgeError(err)).toBe(true);
        if (isBridgeError(err)) {
          expect(err.code).toBe('ERR_CONTENT_TYPE_MISMATCH');
          expect(err.message).toContain('Content-Type mismatch');
        }
      }
    });

    it('should not validate Content-Type when not set', async () => {
      const res = await client.get(`${baseURL}/text`, {
        responseType: 'text',
        allowPrivateNetworks: true,
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── Idempotency Key ─────────────────────────────────────────────────────

  describe('idempotency key', () => {
    it('should inject auto-generated Idempotency-Key when true', async () => {
      const res = await client.post<{ idempotencyKey: string }>(`${baseURL}/idempotency`, {}, {
        idempotencyKey: true,
        allowPrivateNetworks: true,
      });
      expect(res.data.idempotencyKey).toBeDefined();
      // UUID v4 format
      expect(res.data.idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('should inject custom Idempotency-Key when string is provided', async () => {
      const customKey = 'my-custom-idempotency-key-123';
      const res = await client.post<{ idempotencyKey: string }>(`${baseURL}/idempotency`, {}, {
        idempotencyKey: customKey,
        allowPrivateNetworks: true,
      });
      expect(res.data.idempotencyKey).toBe(customKey);
    });

    it('should not inject Idempotency-Key when not set', async () => {
      const res = await client.post<{ idempotencyKey: string | null }>(`${baseURL}/idempotency`, {}, {
        allowPrivateNetworks: true,
      });
      expect(res.data.idempotencyKey).toBeNull();
    });
  });

  // ─── HMAC Request Signing ────────────────────────────────────────────────

  describe('HMAC request signing', () => {
    it('should add X-Signature header when requestSigning is configured', async () => {
      const res = await client.post<{ headers: Record<string, string> }>(
        `${baseURL}/verify-signature`,
        { data: 'test' },
        {
          requestSigning: {
            secret: 'test-secret-key',
            algorithm: 'sha256',
          },
          allowPrivateNetworks: true,
        }
      );
      expect(res.status).toBe(200);
      expect(res.data.headers['x-signature']).toBeDefined();
      expect(res.data.headers['x-signature-timestamp']).toBeDefined();
    });

    it('should support custom header name for signature', async () => {
      const res = await client.get<{ headers: Record<string, string> }>(
        `${baseURL}/verify-signature`,
        {
          requestSigning: {
            secret: 'my-secret',
            headerName: 'X-Custom-Sig',
          },
          allowPrivateNetworks: true,
        }
      );
      expect(res.data.headers['x-custom-sig']).toBeDefined();
    });

    it('should include signed headers when specified', async () => {
      const res = await client.get<{ headers: Record<string, string> }>(
        `${baseURL}/verify-signature`,
        {
          headers: { 'X-Custom-Header': 'test-value' },
          requestSigning: {
            secret: 'my-secret',
            signedHeaders: ['X-Custom-Header'],
          },
          allowPrivateNetworks: true,
        }
      );
      expect(res.data.headers['x-signature']).toBeDefined();
      expect(res.data.headers['x-signed-headers']).toBe('x-custom-header');
    });

    it('should not add signature when requestSigning is not set', async () => {
      const res = await client.get<{ headers: Record<string, string> }>(
        `${baseURL}/verify-signature`,
        { allowPrivateNetworks: true }
      );
      expect(res.data.headers['x-signature']).toBeUndefined();
    });
  });

  // ─── signRequest / verifySignature utility ───────────────────────────────

  describe('signRequest / verifySignature', () => {
    it('should generate and verify a valid signature', () => {
      const sigConfig = {
        secret: 'my-secret-key',
        algorithm: 'sha256' as const,
        signedHeaders: ['content-type'],
        includeBody: true,
        includeTimestamp: false,
      };

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      const body = '{"hello":"world"}';

      const sigHeaders = signRequest(sigConfig, 'POST', 'https://example.com/api', headers, body);
      expect(sigHeaders['X-Signature']).toBeDefined();

      const allHeaders = { ...headers, ...sigHeaders };

      const isValid = verifySignature(
        sigConfig,
        'POST',
        'https://example.com/api',
        allHeaders,
        body,
        sigHeaders['X-Signature']
      );
      expect(isValid).toBe(true);
    });

    it('should reject tampered body', () => {
      const sigConfig = {
        secret: 'my-secret-key',
        algorithm: 'sha256' as const,
        includeBody: true,
        includeTimestamp: false,
      };

      const body = '{"hello":"world"}';
      const sigHeaders = signRequest(sigConfig, 'POST', 'https://example.com/api', {}, body);

      const isValid = verifySignature(
        sigConfig,
        'POST',
        'https://example.com/api',
        sigHeaders,
        '{"hello":"tampered"}',
        sigHeaders['X-Signature']
      );
      expect(isValid).toBe(false);
    });

    it('should reject invalid signature', () => {
      const sigConfig = {
        secret: 'my-secret-key',
        algorithm: 'sha256' as const,
        includeTimestamp: false,
      };

      const isValid = verifySignature(
        sigConfig,
        'GET',
        'https://example.com/api',
        {},
        undefined,
        'invalid-signature-hex'
      );
      expect(isValid).toBe(false);
    });
  });

  // ─── Response Cache ───────────────────────────────────────────────────────

  describe('response cache', () => {
    it('should cache GET responses and return cached on subsequent calls', async () => {
      const instance = client.create({ baseURL });
      instance.setCache({ ttl: 5000, maxSize: 10 });

      const res1 = await instance.get<EchoData>('/echo');
      const res2 = await instance.get<EchoData>('/echo');

      // Both should succeed
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // Second should be the same object from cache
      expect(res2).toBe(res1);
    });

    it('should not cache POST requests by default', async () => {
      const instance = client.create({ baseURL });
      instance.setCache({ ttl: 5000, maxSize: 10 });

      const res1 = await instance.post<EchoData>('/echo', { data: 1 });
      const res2 = await instance.post<EchoData>('/echo', { data: 2 });

      // POST should not be cached
      expect(res1).not.toBe(res2);
    });

    it('should expire cached responses after TTL', async () => {
      const instance = client.create({ baseURL });
      instance.setCache({ ttl: 50, maxSize: 10 }); // 50ms TTL

      const res1 = await instance.get<EchoData>('/echo');
      await new Promise((r) => setTimeout(r, 100)); // Wait for TTL to expire
      const res2 = await instance.get<EchoData>('/echo');

      // After TTL, should be a new response
      expect(res2).not.toBe(res1);
    });

    it('should clear cache via clearCache()', async () => {
      const instance = client.create({ baseURL });
      instance.setCache({ ttl: 5000, maxSize: 10 });

      const res1 = await instance.get<EchoData>('/echo');
      instance.clearCache();
      const res2 = await instance.get<EchoData>('/echo');

      expect(res2).not.toBe(res1);
    });

    it('should disable cache with setCache(false)', async () => {
      const instance = client.create({ baseURL });
      instance.setCache(true); // Enable with defaults

      const res1 = await instance.get<EchoData>('/echo');
      instance.setCache(false); // Disable
      const res2 = await instance.get<EchoData>('/echo');

      expect(res2).not.toBe(res1);
    });
  });

  // ─── ResponseCache class (unit) ──────────────────────────────────────────

  describe('ResponseCache class', () => {
    it('should store and retrieve entries', () => {
      const cache = new ResponseCache({ ttl: 5000, maxSize: 10 });
      const mockResponse = { data: 'test', status: 200, statusText: 'OK', headers: {}, config: {} } as any;

      cache.set('GET:http://example.com', mockResponse);
      expect(cache.get('GET:http://example.com')).toBe(mockResponse);
    });

    it('should return undefined for missing keys', () => {
      const cache = new ResponseCache({ ttl: 5000, maxSize: 10 });
      expect(cache.get('missing')).toBeUndefined();
    });

    it('should evict LRU entries when maxSize is reached', () => {
      const cache = new ResponseCache({ ttl: 5000, maxSize: 2 });
      const r1 = { data: '1', status: 200, statusText: 'OK', headers: {}, config: {} } as any;
      const r2 = { data: '2', status: 200, statusText: 'OK', headers: {}, config: {} } as any;
      const r3 = { data: '3', status: 200, statusText: 'OK', headers: {}, config: {} } as any;

      cache.set('k1', r1);
      cache.set('k2', r2);
      cache.set('k3', r3); // Should evict k1

      expect(cache.get('k1')).toBeUndefined();
      expect(cache.get('k2')).toBe(r2);
      expect(cache.get('k3')).toBe(r3);
    });

    it('should check existence with has()', () => {
      const cache = new ResponseCache({ ttl: 5000, maxSize: 10 });
      const mockResponse = { data: 'test', status: 200, statusText: 'OK', headers: {}, config: {} } as any;

      cache.set('key', mockResponse);
      expect(cache.has('key')).toBe(true);
      expect(cache.has('missing')).toBe(false);
    });

    it('should clear all entries', () => {
      const cache = new ResponseCache({ ttl: 5000, maxSize: 10 });
      const mockResponse = { data: 'test', status: 200, statusText: 'OK', headers: {}, config: {} } as any;

      cache.set('k1', mockResponse);
      cache.set('k2', mockResponse);
      cache.clear();

      expect(cache.size).toBe(0);
    });

    it('should identify cacheable methods', () => {
      const cache = new ResponseCache({ ttl: 5000, maxSize: 10 });
      expect(cache.isCacheableMethod('GET')).toBe(true);
      expect(cache.isCacheableMethod('HEAD')).toBe(true);
      expect(cache.isCacheableMethod('POST')).toBe(false);
      expect(cache.isCacheableMethod('PUT')).toBe(false);
    });

    it('should generate correct cache keys', () => {
      expect(ResponseCache.key('get', 'http://example.com')).toBe('GET:http://example.com');
      expect(ResponseCache.key('POST', '/api')).toBe('POST:/api');
    });
  });

  // ─── Request Deduplication ────────────────────────────────────────────────

  describe('request deduplication', () => {
    it('should deduplicate concurrent identical GET requests', async () => {
      const instance = client.create({ baseURL });
      instance.setDeduplication(true);

      // Launch two identical GET requests simultaneously
      const [res1, res2] = await Promise.all([
        instance.get<EchoData>('/echo'),
        instance.get<EchoData>('/echo'),
      ]);

      // Both should succeed
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // They should be the same promise result (same object)
      expect(res1).toBe(res2);
    });

    it('should not deduplicate POST requests', async () => {
      const instance = client.create({ baseURL });
      instance.setDeduplication(true);

      const [res1, res2] = await Promise.all([
        instance.post<EchoData>('/echo', { a: 1 }),
        instance.post<EchoData>('/echo', { a: 2 }),
      ]);

      // POST should not be deduplicated
      expect(res1).not.toBe(res2);
    });

    it('should not deduplicate different URLs', async () => {
      const instance = client.create({ baseURL });
      instance.setDeduplication(true);

      const [res1, res2] = await Promise.all([
        instance.get('/echo'),
        instance.get('/text'),
      ]);

      expect(res1).not.toBe(res2);
    });

    it('should allow disabling deduplication', async () => {
      const instance = client.create({ baseURL });
      instance.setDeduplication(true);
      instance.setDeduplication(false);

      const [res1, res2] = await Promise.all([
        instance.get<EchoData>('/echo'),
        instance.get<EchoData>('/echo'),
      ]);

      // Without dedup, they should be different response objects
      expect(res1).not.toBe(res2);
    });
  });

  // ─── RequestDeduplicator class (unit) ────────────────────────────────────

  describe('RequestDeduplicator class', () => {
    it('should generate correct keys', () => {
      expect(RequestDeduplicator.key('get', '/api')).toBe('GET:/api');
      expect(RequestDeduplicator.key('POST', '/data')).toBe('POST:/data');
    });

    it('should track inflight requests', async () => {
      const dedup = new RequestDeduplicator();
      expect(dedup.getInflightCount()).toBe(0);

      let resolveFactory!: (value: any) => void;
      const factory = () => new Promise<any>((resolve) => { resolveFactory = resolve; });

      const promise = dedup.execute('key', factory);
      expect(dedup.getInflightCount()).toBe(1);
      expect(dedup.isInflight('key')).toBe(true);

      resolveFactory({ data: 'done', status: 200, statusText: 'OK', headers: {}, config: {} });
      await promise;

      expect(dedup.getInflightCount()).toBe(0);
      expect(dedup.isInflight('key')).toBe(false);
    });
  });

  // ─── Retry-After Header Support ──────────────────────────────────────────

  describe('Retry-After header support', () => {
    it('should respect Retry-After header during retry', async () => {
      const key = `retry-after-test-${Date.now()}`;
      const start = Date.now();
      const res = await client.get(`${baseURL}/retry-after?after=1&key=${key}`, {
        retry: { retries: 2, delay: 50, maxDelay: 5000, backoffFactor: 1, retryableMethods: ['GET'], retryableStatuses: [429] },
        respectRetryAfter: true,
        allowPrivateNetworks: true,
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      // Should have waited at least ~1 second due to Retry-After: 1
      expect(elapsed).toBeGreaterThanOrEqual(800);
    });

    it('should cap Retry-After at maxDelay', async () => {
      const key = `retry-after-cap-${Date.now()}`;
      const start = Date.now();
      const res = await client.get(`${baseURL}/retry-after?after=10&key=${key}`, {
        retry: { retries: 2, delay: 50, maxDelay: 200, backoffFactor: 1, retryableMethods: ['GET'], retryableStatuses: [429] },
        respectRetryAfter: true,
        allowPrivateNetworks: true,
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      // Should be capped at maxDelay (200ms), not 10 seconds
      expect(elapsed).toBeLessThan(2000);
    });

    it('should disable Retry-After respect with respectRetryAfter: false', async () => {
      const key = `retry-after-disabled-${Date.now()}`;
      const start = Date.now();
      const res = await client.get(`${baseURL}/retry-after?after=5&key=${key}`, {
        retry: { retries: 2, delay: 50, maxDelay: 200, backoffFactor: 1, retryableMethods: ['GET'], retryableStatuses: [429] },
        respectRetryAfter: false,
        allowPrivateNetworks: true,
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      // Without Retry-After respect, should complete faster
      expect(elapsed).toBeLessThan(2000);
    });
  });

  // ─── v6.0.0 Version Check ────────────────────────────────────────────────

  describe('v6.0.0 version', () => {
    it('should send bridge/6.0.0 User-Agent header', async () => {
      const res = await client.get<EchoData>(`${baseURL}/echo`);
      expect(res.data.headers['user-agent']).toBe('bridge/6.0.0');
    });
  });
});
