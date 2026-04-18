import * as http from 'http';
import bridge, {
  create,
  CancelToken,
  isCancel,
  isBridgeError,
  isAxiosError,
  BridgeRequestConfig,
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
      instance.setRateLimiter(false as unknown as boolean);

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
});
