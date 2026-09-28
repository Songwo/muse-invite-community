import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommunityState } from '../shared/types';
import type { RpcInput, RpcResult } from './contracts';
import { handleRequest } from './http';

const allowedOrigin = 'https://muse-community.example';
const apiOrigin = 'https://muse-api.example';
const sessionToken = 'A'.repeat(43);
const bodyLimit = 12 * 1024;

const communityState: CommunityState = {
  user: { id: 'member-1', name: '测试成员', createdAt: '2026-09-28T00:00:00.000Z' },
  csrfToken: 'csrf-for-member-1',
  invitations: [],
  claims: [],
  activities: [],
  stats: { availableInvitations: 0, remainingSlots: 0, confirmedClaims: 0, members: 1 },
};

function fixture(result: RpcResult = { status: 200, body: { ok: true } }) {
  const calls: RpcInput[] = [];
  const options = {
    allowedOrigin,
    async dispatch(input: RpcInput): Promise<RpcResult> {
      calls.push(input);
      return result;
    },
  };
  return { calls, options };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`${apiOrigin}${path}`, init);
}

function assertSecurityHeaders(response: Response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.match(response.headers.get('Vary') ?? '', /(?:^|,\s*)Origin(?:,|$)/i);
}

function streamRequest(body: ReadableStream<Uint8Array>, headers?: HeadersInit) {
  return request('/api/invitations', Object.assign({ method: 'POST', body, headers }, { duplex: 'half' }));
}

test('health 返回成功且不调用业务或创建会话', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/health', { headers: { Origin: allowedOrigin } }), options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 0);
  assert.equal(response.headers.get('X-Muse-Session'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assertSecurityHeaders(response);
});

test('正确来源获得状态及可读会话响应头，JSON 不包含会话令牌', async () => {
  const { calls, options } = fixture({ status: 200, body: communityState, sessionToken });
  const response = await handleRequest(request('/api/state', { headers: { Origin: allowedOrigin } }), options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), communityState);
  assert.equal(response.headers.get('X-Muse-Session'), sessionToken);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'X-Muse-Session');
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/state', ip: 'unknown' }]);
  assertSecurityHeaders(response);
});

test('缺少 Origin 的命令行请求可以访问 API', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/state'), options);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assertSecurityHeaders(response);
});

test('拒绝恶意、null 及并非精确匹配的 Origin', async (t) => {
  for (const origin of ['https://evil.example', 'null', `${allowedOrigin}/`, `${allowedOrigin}.evil.example`]) {
    await t.test(origin, async () => {
      const { calls, options } = fixture();
      const response = await handleRequest(request('/api/state', { headers: { Origin: origin } }), options);
      assert.equal(response.status, 403);
      assert.equal(calls.length, 0);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
      assert.equal(typeof (await response.json()).error, 'string');
      assertSecurityHeaders(response);
    });
  }
});

test('预检允许 GET、POST、PATCH 及限定请求头', async (t) => {
  for (const method of ['GET', 'POST', 'PATCH']) {
    await t.test(method, async () => {
      const { calls, options } = fixture();
      const response = await handleRequest(request('/api/invitations', {
        method: 'OPTIONS',
        headers: {
          Origin: allowedOrigin,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'Content-Type, x-Csrf-Token, AUTHORIZATION',
        },
      }), options);
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
      assert.equal(calls.length, 0);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
      assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, PATCH');
      assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type, X-CSRF-Token, Authorization');
      assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'X-Muse-Session');
      assertSecurityHeaders(response);
    });
  }
});

test('无自定义请求头的合法预检可以通过', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/state', {
    method: 'OPTIONS', headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': 'GET' },
  }), options);
  assert.equal(response.status, 204);
  assert.equal(calls.length, 0);
});

test('预检拒绝不允许的请求方法', async (t) => {
  for (const method of ['DELETE', 'PUT', 'HEAD', 'get']) {
    await t.test(method, async () => {
      const { calls, options } = fixture();
      const response = await handleRequest(request('/api/state', {
        method: 'OPTIONS', headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': method },
      }), options);
      assert.equal(response.status, 403);
      assert.equal(calls.length, 0);
      assertSecurityHeaders(response);
    });
  }
});

test('预检拒绝不允许或格式错误的请求头列表', async (t) => {
  for (const header of ['Cookie', 'X-User-Id', 'Content-Type, X-Forwarded-For', 'Content-Type,,Authorization']) {
    await t.test(header, async () => {
      const { calls, options } = fixture();
      const response = await handleRequest(request('/api/state', {
        method: 'OPTIONS',
        headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': header },
      }), options);
      assert.equal(response.status, 403);
      assert.equal(calls.length, 0);
      assertSecurityHeaders(response);
    });
  }
});

test('缺少请求方法的预检返回 400', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/state', { method: 'OPTIONS', headers: { Origin: allowedOrigin } }), options);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('非 API 路径返回 JSON 404', async (t) => {
  for (const path of ['/', '/index.html', '/apix', '/apiary/state']) {
    await t.test(path, async () => {
      const { calls, options } = fixture();
      const response = await handleRequest(request(path), options);
      assert.equal(response.status, 404);
      assert.equal(typeof (await response.json()).error, 'string');
      assert.equal(calls.length, 0);
      assertSecurityHeaders(response);
    });
  }
});

test('API 根目录和未知 API 路由交由业务返回 404', async (t) => {
  for (const path of ['/api', '/api/unknown']) {
    await t.test(path, async () => {
      const { calls, options } = fixture({ status: 404, body: { error: '接口不存在。' } });
      const response = await handleRequest(request(path, { headers: { Origin: allowedOrigin } }), options);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: '接口不存在。' });
      assert.equal(calls[0].path, path);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
      assertSecurityHeaders(response);
    });
  }
});

test('不支持的请求方法返回 405 及 Allow', async (t) => {
  for (const method of ['PUT', 'DELETE', 'HEAD']) {
    await t.test(method, async () => {
      const { calls, options } = fixture();
      const response = await handleRequest(request('/api/state', { method }), options);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('Allow'), 'GET, POST, PATCH, OPTIONS');
      assert.equal(calls.length, 0);
      assertSecurityHeaders(response);
    });
  }
});

test('Bearer 会话令牌传递给业务层', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/state', { headers: { Authorization: `Bearer ${sessionToken}` } }), options);
  assert.equal(response.status, 200);
  assert.equal(calls[0].sessionToken, sessionToken);
});

test('Bearer 允许 base64url 字符且认证方案大小写不敏感', async () => {
  const { calls, options } = fixture();
  const token = `_${'-'.repeat(41)}A`;
  const response = await handleRequest(request('/api/state', { headers: { Authorization: `bearer ${token}` } }), options);
  assert.equal(response.status, 200);
  assert.equal(calls[0].sessionToken, token);
});

test('非法 Authorization 在业务调用前返回 401', async (t) => {
  for (const authorization of ['', `Basic ${sessionToken}`, 'Bearer short', `Bearer ${'A'.repeat(44)}`, `Bearer ${'+'.repeat(43)}`, `Bearer ${'/'.repeat(43)}`, `Bearer ${'A'.repeat(42)}=`, `Bearer  ${sessionToken}`, `Bearer ${sessionToken}, Bearer ${sessionToken}`]) {
    await t.test(authorization || '空 Authorization', async () => {
      const { calls, options } = fixture();
      const response = await handleRequest(request('/api/state', { headers: { Authorization: authorization } }), options);
      assert.equal(response.status, 401);
      assert.equal(calls.length, 0);
      assertSecurityHeaders(response);
    });
  }
});

test('Cookie、用户标识和 X-Forwarded-For 不能作为身份或 IP 来源', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/state?userId=forged-user', {
    headers: { Cookie: `muse_session=${sessionToken}`, 'X-User-Id': 'forged-user', 'X-Forwarded-For': '203.0.113.6' },
  }), options);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/state', ip: 'unknown' }]);
});

test('POST 传递真实 CF IP、CSRF、会话令牌和 JSON 请求体', async () => {
  const { calls, options } = fixture();
  const body = { kind: 'code', content: 'MUSE-TEST', capacity: 1 };
  const response = await handleRequest(request('/api/invitations', {
    method: 'POST',
    headers: {
      Origin: allowedOrigin,
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json; charset=utf-8',
      'X-CSRF-Token': 'csrf-for-member-1',
      'CF-Connecting-IP': '203.0.113.7',
      'X-Forwarded-For': '203.0.113.6',
    },
    body: JSON.stringify(body),
  }), options);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ method: 'POST', path: '/api/invitations', sessionToken, csrfToken: 'csrf-for-member-1', ip: '203.0.113.7', body }]);
});

test('POST 和 PATCH 的空请求体接受为空对象', async (t) => {
  for (const method of ['POST', 'PATCH']) {
    await t.test(method, async () => {
      const { calls, options } = fixture();
      const response = await handleRequest(request('/api/invitations/invite-1', { method }), options);
      assert.equal(response.status, 200);
      assert.deepEqual(calls[0].body, {});
    });
  }
});

test('GET 不要求 Content-Type 或 JSON 请求体', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/state', { headers: { 'Content-Type': 'text/plain' } }), options);
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(calls[0], 'body'), false);
});

test('非空请求体缺少或使用错误媒体类型时返回 415', async (t) => {
  for (const contentType of [undefined, 'text/plain', 'application/json-extra', 'application/x-www-form-urlencoded']) {
    await t.test(contentType ?? '缺少 Content-Type', async () => {
      const { calls, options } = fixture();
      const headers = new Headers();
      if (contentType) headers.set('Content-Type', contentType);
      const response = await handleRequest(request('/api/invitations', { method: 'POST', headers, body: new TextEncoder().encode('{}') }), options);
      assert.equal(response.status, 415);
      assert.equal(calls.length, 0);
      assertSecurityHeaders(response);
    });
  }
});

test('坏 JSON 返回 400', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/invitations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: allowedOrigin }, body: '{broken',
  }), options);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assertSecurityHeaders(response);
});

test('恰好 12 KiB 的 JSON 请求体可以通过', async () => {
  const { calls, options } = fixture();
  const body = { note: 'x'.repeat(bodyLimit - JSON.stringify({ note: '' }).length) };
  const encoded = JSON.stringify(body);
  assert.equal(new TextEncoder().encode(encoded).length, bodyLimit);
  const response = await handleRequest(request('/api/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: encoded }), options);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].body, body);
});

test('没有 Content-Length 的分块超大请求被中断并返回 413', async () => {
  const { calls, options } = fixture();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8000).fill(32));
      controller.enqueue(new Uint8Array(5000).fill(32));
    },
    cancel() { cancelled = true; },
  });
  const response = await handleRequest(streamRequest(stream, { 'Content-Type': 'application/json', Origin: allowedOrigin }), options);
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
  assertSecurityHeaders(response);
});

test('请求体按 UTF-8 字节而非字符数量限制', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/invitations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '界'.repeat(5000) }),
  }), options);
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('伪造的小 Content-Length 不能绕过请求体限制', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/invitations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2' }, body: JSON.stringify({ note: 'x'.repeat(bodyLimit) }),
  }), options);
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('声明超限的 Content-Length 返回 413', async () => {
  const { calls, options } = fixture();
  const response = await handleRequest(request('/api/invitations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(bodyLimit + 1) }, body: '{}',
  }), options);
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('请求流读取故障返回 400，故障细节不出现在响应中', async () => {
  const { calls, options } = fixture();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('secret-read-error')); } });
  const response = await handleRequest(streamRequest(stream, { 'Content-Type': 'application/json' }), options);
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /secret-read-error/);
  assert.equal(calls.length, 0);
});

test('会话令牌只在成功的 GET state 响应头返回', async (t) => {
  for (const [method, path, status] of [['POST', '/api/invitations', 201], ['GET', '/api/unknown', 200], ['GET', '/api/state', 403]] as const) {
    await t.test(`${method} ${path} ${status}`, async () => {
      const { options } = fixture({ status, body: { ok: true }, sessionToken });
      const response = await handleRequest(request(path, { method }), options);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('X-Muse-Session'), null);
      assert.doesNotMatch(await response.text(), new RegExp(sessionToken));
    });
  }
});

test('业务调度故障返回带安全与跨域头的 500，且不泄漏异常细节', async () => {
  const response = await handleRequest(request('/api/state', { headers: { Origin: allowedOrigin } }), {
    allowedOrigin,
    async dispatch(): Promise<RpcResult> { throw new Error(`secret-db-token:${sessionToken}`); },
  });
  assert.equal(response.status, 500);
  assert.equal(typeof (await response.clone().json()).error, 'string');
  assert.doesNotMatch(await response.text(), /secret-db-token|AAAAAAAA/);
  assert.equal(response.headers.get('X-Muse-Session'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assertSecurityHeaders(response);
});

test('状态响应无法序列化时，500 响应不能带出刚创建的会话令牌', async () => {
  const cyclicState = { ...communityState };
  Object.assign(cyclicState, { self: cyclicState });
  const { options } = fixture({ status: 200, body: cyclicState, sessionToken });
  const response = await handleRequest(request('/api/state', { headers: { Origin: allowedOrigin } }), options);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('X-Muse-Session'), null);
  assert.doesNotMatch(await response.text(), new RegExp(sessionToken));
  assertSecurityHeaders(response);
});
