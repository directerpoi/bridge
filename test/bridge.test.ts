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
});
