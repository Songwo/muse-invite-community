import type { CommunityState } from '../../shared/types';

const baseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const sessionKey = `muse-session:${baseUrl}`;

export function requestState(path = '/api/state', method = 'GET', body?: unknown, csrfToken?: string): Promise<CommunityState> {
  if (baseUrl && path === '/api/state' && method === 'GET') {
    if (!navigator.locks) return Promise.reject(new Error('当前浏览器无法安全建立互助身份，请使用新版浏览器。'));
    // 跨标签串行建立身份，等待锁后再读取其他页面保存的令牌。
    return navigator.locks.request(sessionKey, () => requestStateInternal(path, method, body, csrfToken));
  }
  return requestStateInternal(path, method, body, csrfToken);
}

export function subscribeSessionChanges(onChange: () => void): () => void {
  const listener = (event: StorageEvent) => {
    if (baseUrl && event.storageArea === localStorage && (event.key === sessionKey || event.key === null)) onChange();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

async function requestStateInternal(path: string, method: string, body?: unknown, csrfToken?: string): Promise<CommunityState> {
  let response: Response;
  let sessionToken: string | null = null;
  if (baseUrl) {
    try { sessionToken = localStorage.getItem(sessionKey); }
    catch { throw new Error('无法读取浏览器身份，请允许此网站使用本地存储。'); }
  }
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      credentials: baseUrl ? 'omit' : 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}), ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error('连接失败，请检查网络后重试。');
  }
  if (baseUrl && path === '/api/state' && method === 'GET' && response.status === 401 && sessionToken) {
    try { localStorage.removeItem(sessionKey); }
    catch { throw new Error('浏览器身份已失效，请清除本网站的存储后重试。'); }
    return requestStateInternal(path, method, body, csrfToken);
  }
  const nextToken = response.headers.get('x-muse-session');
  if (baseUrl && nextToken && response.ok) {
    try { localStorage.setItem(sessionKey, nextToken); }
    catch { throw new Error('无法保存浏览器身份，请允许此网站使用本地存储后重试。'); }
  }
  const data = await response.json().catch(() => null) as CommunityState | { error?: string } | null;
  if (!response.ok) throw new Error(data && 'error' in data && data.error ? data.error : '请求未成功，请重试。');
  if (!data || !('invitations' in data)) throw new Error('服务器返回异常，请刷新后重试。');
  return data;
}
