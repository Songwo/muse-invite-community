import type { RpcInput, RpcResult } from './contracts';

const bodyLimit = 12 * 1024;
const allowedMethods = new Set(['GET', 'POST', 'PATCH']);
const allowedHeaders = new Set(['content-type', 'x-csrf-token', 'authorization']);

class RequestBodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > bodyLimit) {
    await request.body?.cancel().catch(() => undefined);
    throw new RequestBodyError(413, '请求体不能超过 12 KiB。');
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    // Content-Length 可伪造或缺失，始终以流中实际收到的字节为准。
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyError(413, '请求体不能超过 12 KiB。');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, '无法读取请求体。');
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return {};

  const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new RequestBodyError(415, '请求体必须使用 application/json。');
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new RequestBodyError(400, '请求体不是有效的 JSON。');
  }
}

export async function handleRequest(
  request: Request,
  options: { allowedOrigin: string; dispatch: (input: RpcInput) => Promise<RpcResult> },
): Promise<Response> {
  const origin = request.headers.get('Origin');
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  if (origin !== null && origin === options.allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'X-Muse-Session');
  }
  const json = (body: RpcResult['body'], status: number): Response => {
    return Response.json(body, { status, headers });
  };
  const error = (status: number, message: string): Response => json({ error: message }, status);

  if (origin !== null && origin !== options.allowedOrigin) {
    return error(403, '此来源不允许访问。');
  }

  const path = new URL(request.url).pathname;
  if (path !== '/api' && !path.startsWith('/api/')) {
    return error(404, '接口不存在。');
  }

  if (request.method === 'OPTIONS') {
    const method = request.headers.get('Access-Control-Request-Method');
    if (!method) return error(400, '预检缺少请求方法。');
    if (!allowedMethods.has(method)) return error(403, '预检请求方法不受支持。');

    const requestedHeaders = request.headers.get('Access-Control-Request-Headers');
    if (requestedHeaders && requestedHeaders.split(',').some((header) => !allowedHeaders.has(header.trim().toLowerCase()))) {
      return error(403, '预检请求头不受支持。');
    }
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Authorization');
    return new Response(null, { status: 204, headers });
  }

  if (!allowedMethods.has(request.method)) {
    headers.set('Allow', 'GET, POST, PATCH, OPTIONS');
    return error(405, '不支持此请求方法。');
  }
  if (request.method === 'GET' && path === '/api/health') {
    return json({ ok: true }, 200);
  }

  const input: RpcInput = {
    method: request.method,
    path,
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
  };
  const authorization = request.headers.get('Authorization');
  if (authorization !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) return error(401, '身份凭证格式无效，请重新打开网站。');
    input.sessionToken = match[1];
  }
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (csrfToken !== null) input.csrfToken = csrfToken;

  try {
    if (request.method === 'POST' || request.method === 'PATCH') {
      input.body = await readJsonBody(request);
    }
    const result = await options.dispatch(input);
    const response = json(result.body, result.status);
    if (request.method === 'GET' && path === '/api/state' && result.status >= 200 && result.status < 300 && result.sessionToken) {
      response.headers.set('X-Muse-Session', result.sessionToken);
    }
    return response;
  } catch (failure) {
    if (failure instanceof RequestBodyError) return error(failure.status, failure.message);
    console.error('Worker request failed', failure);
    return error(500, '服务暂时不可用，请稍后重试。');
  }
}
