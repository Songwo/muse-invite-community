import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.ts';
import type { CommunityState, PublishInput } from '../shared/types.ts';

type HttpResult = { response: Response; body: CommunityState & { error?: string } };

async function fixture(t: TestContext, clock?: () => Date) {
  const directory = await mkdtemp(join(tmpdir(), 'muse-invite-test-'));
  const databasePath = join(directory, 'community.sqlite');
  let current: ReturnType<typeof createApp>;
  let server: Server;
  let baseUrl = '';
  async function start() {
    current = createApp({ databasePath, now: clock });
    server = await new Promise<Server>((resolve) => {
      const listening = current.app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    current.close();
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });

  function client() {
    let cookie = '';
    let csrfToken = '';
    return {
      async request(path: string, method = 'GET', data?: unknown, extraHeaders: Record<string, string> = {}): Promise<HttpResult> {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-csrf-token': csrfToken } : {}),
            ...extraHeaders,
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const body = await response.json() as HttpResult['body'];
        if (body.csrfToken) csrfToken = body.csrfToken;
        return { response, body };
      },
      async state(): Promise<CommunityState> {
        const result = await this.request('/api/state');
        assert.equal(result.response.status, 200, JSON.stringify(result.body));
        return result.body;
      },
    };
  }
  return {
    client,
    restart: async () => { await stop(); await start(); },
    get url() { return baseUrl; },
  };
}

const invitation: PublishInput = { kind: 'code', content: 'MuSe-Test-Secret-8x', note: '新分享的邀请码', capacity: 1, expiresInDays: 7 };

async function publish(client: ReturnType<Awaited<ReturnType<typeof fixture>>['client']>, input: Partial<PublishInput> = {}) {
  const result = await client.request('/api/invitations', 'POST', { ...invitation, ...input });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.invitations.find((item) => item.content === (input.content ?? invitation.content))!;
}

test('首次访问创建身份并返回空社区，不生成虚构记录', async (t) => {
  const app = await fixture(t);
  const client = app.client();
  const result = await client.request('/api/state');
  assert.equal(result.response.status, 200);
  assert.ok(result.body.user.id);
  assert.ok(result.body.csrfToken.length >= 32);
  assert.deepEqual(result.body.invitations, []);
  assert.deepEqual(result.body.claims, []);
  assert.deepEqual(result.body.activities, []);
  assert.deepEqual(result.body.stats, { availableInvitations: 0, remainingSlots: 0, confirmedClaims: 0, members: 1 });
  assert.match(result.response.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.match(result.response.headers.get('set-cookie') ?? '', /SameSite=Lax/i);
  assert.equal((await client.state()).user.id, result.body.user.id);
});

test('两个用户完成分享、领取、提交和确认，只有确认才计为成功', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  await owner.state();
  await member.state();
  await owner.request('/api/profile', 'PATCH', { name: '分享者' });
  await member.request('/api/profile', 'PATCH', { name: '领取者' });
  const shared = await publish(owner);
  assert.equal(shared.content, invitation.content);
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  assert.equal(claimed.response.status, 201);
  const claim = claimed.body.claims[0];
  assert.equal(claim.status, 'reserved');
  assert.equal(claim.invitation.content, invitation.content);
  assert.equal(claim.invitation.remaining, 0);
  assert.equal(claimed.body.stats.confirmedClaims, 0);
  const submitted = await member.request(`/api/claims/${claim.id}/feedback`, 'POST', { result: 'submitted', note: '已提交申请' });
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.body.claims[0].status, 'submitted');
  assert.equal(submitted.body.stats.confirmedClaims, 0);
  const confirmed = await owner.request(`/api/claims/${claim.id}/review`, 'POST', { decision: 'confirm', note: '欢迎加入' });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.claims[0].status, 'confirmed');
  assert.equal(confirmed.body.claims[0].ownerNote, '欢迎加入');
  assert.equal(confirmed.body.invitations[0].confirmedCount, 1);
  assert.equal(confirmed.body.stats.confirmedClaims, 1);
  assert.equal(confirmed.body.activities.filter((item) => item.kind === 'confirmed').length, 1);
});

test('公开状态隐藏完整邀请码与私人反馈，只有相关当事人可见', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  const stranger = app.client();
  await owner.state();
  await member.state();
  await stranger.state();
  const shared = await publish(owner);
  const publicState = await stranger.state();
  assert.equal(publicState.invitations[0].content, undefined);
  assert.ok(!JSON.stringify(publicState).includes(invitation.content));
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  await member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'invalid', note: '仅当事人可见的反馈' });
  const strangerState = await stranger.state();
  assert.deepEqual(strangerState.claims, []);
  assert.ok(!JSON.stringify(strangerState).includes('仅当事人可见的反馈'));
  assert.equal((await owner.state()).claims[0].feedbackNote, '仅当事人可见的反馈');
  await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'reject', note: '核对后释放名额' });
  const rejectedState = await member.state();
  assert.equal(rejectedState.invitations[0].content, undefined);
  assert.equal(rejectedState.claims[0].invitation.content, undefined);
});

test('无会话、错误 CSRF 和跨域请求不能写入', async (t) => {
  const app = await fixture(t);
  const unknown = app.client();
  const denied = await unknown.request('/api/invitations', 'POST', invitation);
  assert.equal(denied.response.status, 401);
  const owner = app.client();
  await owner.state();
  const wrongCsrf = await owner.request('/api/invitations', 'POST', invitation, { 'x-csrf-token': 'wrong' });
  assert.equal(wrongCsrf.response.status, 403);
  const crossOrigin = await owner.request('/api/invitations', 'POST', invitation, { origin: 'https://evil.example' });
  assert.equal(crossOrigin.response.status, 403);
  const opaqueOrigin = await owner.request('/api/invitations', 'POST', invitation, { origin: 'null' });
  assert.equal(opaqueOrigin.response.status, 403);
  assert.deepEqual((await owner.state()).invitations, []);
  const validOrigin = await owner.request('/api/invitations', 'POST', invitation, { origin: app.url });
  assert.equal(validOrigin.response.status, 201);
});

test('额外 ownerId 和 claimantId 不会冒充其他用户，越权操作被拒绝', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  const stranger = app.client();
  const ownerState = await owner.state();
  const memberState = await member.state();
  await stranger.state();
  const result = await owner.request('/api/invitations', 'POST', { ...invitation, ownerId: memberState.user.id });
  const shared = result.body.invitations[0];
  assert.equal(shared.ownerId, ownerState.user.id);
  assert.equal((await owner.request(`/api/invitations/${shared.id}/claim`, 'POST', {})).response.status, 409);
  assert.equal((await stranger.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'close' })).response.status, 403);
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', { claimantId: ownerState.user.id });
  const claim = claimed.body.claims[0];
  assert.equal(claim.claimantId, memberState.user.id);
  assert.equal((await stranger.request(`/api/claims/${claim.id}/feedback`, 'POST', { result: 'submitted', note: '' })).response.status, 403);
  assert.equal((await owner.request(`/api/claims/${claim.id}/cancel`, 'POST', {})).response.status, 403);
  await member.request(`/api/claims/${claim.id}/feedback`, 'POST', { result: 'submitted', note: '' });
  assert.equal((await member.request(`/api/claims/${claim.id}/review`, 'POST', { decision: 'confirm', note: '' })).response.status, 403);
  assert.equal((await stranger.request(`/api/claims/${claim.id}/review`, 'POST', { decision: 'confirm', note: '' })).response.status, 403);
});

test('并发抢最后一个名额时只允许一人领取', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const first = app.client();
  const second = app.client();
  await owner.state();
  await first.state();
  await second.state();
  const shared = await publish(owner);
  const responses = await Promise.all([
    first.request(`/api/invitations/${shared.id}/claim`, 'POST', {}),
    second.request(`/api/invitations/${shared.id}/claim`, 'POST', {}),
  ]);
  assert.deepEqual(responses.map((item) => item.response.status).sort(), [201, 409]);
  const ownerState = await owner.state();
  assert.equal(ownerState.claims.length, 1);
  assert.equal(ownerState.invitations[0].remaining, 0);
  assert.equal(ownerState.invitations[0].status, 'full');
});

test('重复领取不会占多个名额，取消释放名额并允许再次领取', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  await owner.state();
  await member.state();
  const shared = await publish(owner, { capacity: 2 });
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  assert.equal((await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {})).response.status, 409);
  assert.equal((await owner.state()).invitations[0].remaining, 1);
  const cancelled = await member.request(`/api/claims/${claimId}/cancel`, 'POST', {});
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.claims[0].status, 'cancelled');
  assert.equal(cancelled.body.invitations[0].remaining, 2);
  assert.equal(cancelled.body.invitations[0].content, undefined);
  assert.equal((await member.request(`/api/claims/${claimId}/cancel`, 'POST', {})).response.status, 409);
  const reclaimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  assert.equal(reclaimed.response.status, 201);
  assert.equal(reclaimed.body.invitations[0].remaining, 1);
  assert.equal(reclaimed.body.claims.filter((item) => item.status === 'reserved').length, 1);
});

test('无效反馈保留名额，分享者拒绝后释放，不能直接确认无效反馈', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  await owner.state();
  await member.state();
  const shared = await publish(owner);
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  const invalid = await member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'invalid', note: '提示邀请码无效' });
  assert.equal(invalid.response.status, 200);
  assert.equal(invalid.body.invitations[0].remaining, 0);
  assert.equal(invalid.body.invitations[0].pendingCount, 1);
  assert.equal((await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' })).response.status, 409);
  const rejected = await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'reject', note: '已检查并释放' });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.invitations[0].remaining, 1);
  assert.equal(rejected.body.claims[0].status, 'rejected');
  assert.equal((await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {})).response.status, 201);
});

test('确认不能重复记账，已确认记录不能取消或改反馈', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  await owner.state();
  await member.state();
  const shared = await publish(owner);
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  assert.equal((await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' })).response.status, 409);
  await member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'submitted', note: '' });
  assert.equal((await member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'submitted', note: '' })).response.status, 409);
  await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' });
  assert.equal((await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' })).response.status, 409);
  assert.equal((await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'reject', note: '重复拒绝不应生效' })).response.status, 409);
  assert.equal((await member.request(`/api/claims/${claimId}/cancel`, 'POST', {})).response.status, 409);
  assert.equal((await member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'invalid', note: '重复反馈不应生效' })).response.status, 409);
  const state = await owner.state();
  assert.equal(state.stats.confirmedClaims, 1);
  assert.equal(state.activities.filter((item) => item.kind === 'confirmed').length, 1);
});

test('暂停可恢复，关闭不可恢复，已领取人仍可反馈', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  await owner.state();
  await member.state();
  const shared = await publish(owner, { capacity: 2 });
  const paused = await owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'pause' });
  assert.equal(paused.body.invitations[0].status, 'paused');
  assert.equal((await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {})).response.status, 409);
  assert.equal((await owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'resume' })).response.status, 200);
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  const closed = await owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'close' });
  assert.equal(closed.body.invitations[0].status, 'closed');
  assert.equal((await owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'resume' })).response.status, 409);
  assert.equal((await member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'submitted', note: '' })).response.status, 200);
  assert.equal((await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' })).response.status, 200);
});

test('到期时停止新领取，保留已领取反馈和确认，并优先显示暂停状态', async (t) => {
  let currentDate = new Date('2026-09-28T00:00:00.000Z');
  const app = await fixture(t, () => currentDate);
  const owner = app.client();
  const member = app.client();
  const stranger = app.client();
  await owner.state();
  await member.state();
  await stranger.state();
  const shared = await publish(owner, { capacity: 2, expiresInDays: 1 });
  assert.equal(shared.expiresAt, '2026-09-29T00:00:00.000Z');
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  currentDate = new Date('2026-09-29T00:00:00.000Z');
  const expiredState = await owner.state();
  assert.equal(expiredState.invitations[0].status, 'expired');
  assert.equal(expiredState.stats.availableInvitations, 0);
  assert.equal(expiredState.stats.remainingSlots, 0);
  assert.equal((await stranger.request(`/api/invitations/${shared.id}/claim`, 'POST', {})).response.status, 409);
  assert.equal((await member.request(`/api/claims/${claimed.body.claims[0].id}/feedback`, 'POST', { result: 'submitted', note: '' })).response.status, 200);
  assert.equal((await owner.request(`/api/claims/${claimed.body.claims[0].id}/review`, 'POST', { decision: 'confirm', note: '' })).response.status, 200);
  const paused = await owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'pause' });
  assert.equal(paused.body.invitations[0].status, 'paused');
});

test('链接仅接受 HTTPS Muse 域名，拒绝恶意域名、凭证与非默认端口', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  await owner.state();
  for (const content of [
    'javascript:alert(1)', 'http://muse.ai/invite', 'https://muse.ai.evil.example/invite',
    'https://evil-muse.ai/invite', 'https://user:pass@muse.ai/invite', 'https://muse.ai:8443/invite',
    'https://muse.ai\\@evil.example/invite',
  ]) {
    const result = await owner.request('/api/invitations', 'POST', { ...invitation, kind: 'link', content });
    assert.equal(result.response.status, 400, content);
  }
  const valid = await publish(owner, { kind: 'link', content: 'https://app.muse.ai/any-official-path?token=CaseKept' });
  assert.equal(valid.content, 'https://app.muse.ai/any-official-path?token=CaseKept');
  const stranger = app.client();
  assert.ok(!JSON.stringify(await stranger.state()).includes('CaseKept'));
});

test('输入限制阻止越界容量、文本与昵称，错误统一为 JSON', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  await owner.state();
  await member.state();
  for (const input of [{ capacity: 0 }, { capacity: 21 }, { capacity: 1.5 }, { expiresInDays: 0 }, { expiresInDays: 31 }, { content: 'abc' }, { content: 'A'.repeat(121) }, { note: '字'.repeat(161) }]) {
    const result = await owner.request('/api/invitations', 'POST', { ...invitation, ...input });
    assert.equal(result.response.status, 400);
    assert.equal(typeof result.body.error, 'string');
  }
  for (const name of ['a', 'A'.repeat(17), '用\u0000户']) {
    assert.equal((await owner.request('/api/profile', 'PATCH', { name })).response.status, 400);
  }
  assert.equal((await owner.request('/api/profile', 'PATCH', { name: '合适昵称' })).response.status, 200);
  const shared = await publish(owner);
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  assert.equal((await member.request(`/api/claims/${claimed.body.claims[0].id}/feedback`, 'POST', { result: 'submitted', note: '字'.repeat(241) })).response.status, 400);
  assert.equal((await member.request(`/api/claims/${claimed.body.claims[0].id}/feedback`, 'POST', { result: 'invalid', note: '   ' })).response.status, 400);
  await member.request(`/api/claims/${claimed.body.claims[0].id}/feedback`, 'POST', { result: 'submitted', note: '' });
  assert.equal((await owner.request(`/api/claims/${claimed.body.claims[0].id}/review`, 'POST', { decision: 'reject', note: '   ' })).response.status, 400);
  assert.equal((await owner.request('/api/unknown')).response.status, 404);
  const nonApi = await fetch(`${app.url}/not-api`);
  assert.equal(nonApi.status, 404);
  assert.match(nonApi.headers.get('content-type') ?? '', /text\/html/);
});

test('重启后身份、分享、领取和反馈仍保存在真实 SQLite 数据库', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  const before = await owner.state();
  await member.state();
  await owner.request('/api/profile', 'PATCH', { name: '持久化昵称' });
  const shared = await publish(owner);
  const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  await member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'submitted', note: '重启前的反馈' });
  await app.restart();
  const restoredOwner = await owner.state();
  assert.equal(restoredOwner.user.id, before.user.id);
  assert.equal(restoredOwner.user.name, '持久化昵称');
  assert.equal(restoredOwner.invitations[0].id, shared.id);
  assert.equal(restoredOwner.invitations[0].content, invitation.content);
  assert.equal(restoredOwner.claims[0].feedbackNote, '重启前的反馈');
  assert.equal((await member.state()).claims[0].id, claimId);
  assert.equal((await owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' })).response.status, 200);
});

test('会话创建和重复发布有速率限制，错误请求不消耗发布名额', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  await owner.state();
  for (let index = 0; index < 25; index++) {
    assert.equal((await owner.request('/api/invitations', 'POST', { ...invitation, capacity: 0 })).response.status, 400);
  }
  const statuses: number[] = [];
  for (let index = 0; index < 25; index++) {
    statuses.push((await owner.request('/api/invitations', 'POST', { ...invitation, content: `Code-${index}` })).response.status);
  }
  assert.ok(statuses.includes(201));
  assert.ok(statuses.includes(429));
  assert.ok((await owner.state()).invitations.length <= 20);
  const sessionStatuses: number[] = [];
  for (let index = 0; index < 45; index++) sessionStatuses.push((await app.client().request('/api/state')).response.status);
  assert.ok(sessionStatuses.includes(200));
  assert.ok(sessionStatuses.includes(429));
});

test('反复领取和取消会触发领取限流，限流不妨碍取消释放名额', async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const member = app.client();
  await owner.state();
  await member.state();
  const shared = await publish(owner);
  const statuses: number[] = [];
  for (let index = 0; index < 35; index++) {
    const claimed = await member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
    statuses.push(claimed.response.status);
    if (claimed.response.status === 429) break;
    assert.equal(claimed.response.status, 201);
    const active = claimed.body.claims.find((item) => item.status === 'reserved')!;
    assert.equal((await member.request(`/api/claims/${active.id}/cancel`, 'POST', {})).response.status, 200);
  }
  assert.ok(statuses.includes(429), '重复领取必须受到限流');
  const ownerState = await owner.state();
  assert.equal(ownerState.invitations[0].remaining, 1);
  assert.ok(ownerState.claims.length <= 30);
});
