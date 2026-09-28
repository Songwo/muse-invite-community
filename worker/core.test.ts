import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { CommunityState, PublishInput } from '../shared/types.ts';
import { createCommunityCore, type SqlDatabase } from './core.ts';
import type { RpcInput } from './contracts.ts';

function fixture(t: TestContext, now?: () => Date) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-worker-test-'));
  const databasePath = join(directory, 'community.sqlite');
  let database: DatabaseSync;
  let core: ReturnType<typeof createCommunityCore>;
  function start() {
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    let inTransaction = false;
    const adapter: SqlDatabase = {
      query<T>(sql: string, ...values: (string | number | null)[]) {
        assert.ok(inTransaction, '业务查询必须位于同步事务内');
        return database.prepare(sql).all(...values) as unknown as T[];
      },
      run(sql, ...values) {
        assert.ok(inTransaction, '业务写入必须位于同步事务内');
        database.prepare(sql).run(...values);
      },
      transaction<T>(operation: () => T): T {
        assert.equal(inTransaction, false, '不应嵌套同步事务');
        database.exec('BEGIN IMMEDIATE');
        inTransaction = true;
        try {
          const result = operation();
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        } finally {
          inTransaction = false;
        }
      },
    };
    core = createCommunityCore(adapter, { now });
  }
  start();
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function client(ip = '192.0.2.1') {
    let sessionToken: string | undefined;
    let csrfToken: string | undefined;
    return {
      request(path: string, method = 'GET', body?: unknown, overrides: Partial<RpcInput> = {}) {
        const result = core.handle({ path, method, body, sessionToken, csrfToken, ip, ...overrides });
        if (result.sessionToken) sessionToken = result.sessionToken;
        if ('csrfToken' in result.body) csrfToken = result.body.csrfToken;
        return { ...result, body: result.body as CommunityState & { error?: string } };
      },
      state() {
        const result = this.request('/api/state');
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return result.body;
      },
      get token() { return sessionToken; },
    };
  }
  return {
    client,
    restart() { database.close(); start(); },
    get database() { return database; },
  };
}

const invitation: PublishInput = { kind: 'code', content: 'MuSe-Cloud-Secret-x7', note: '云端分享', capacity: 1, expiresInDays: 7 };
type Client = ReturnType<ReturnType<typeof fixture>['client']>;

function publish(client: Client, input: Partial<PublishInput> = {}) {
  const result = client.request('/api/invitations', 'POST', { ...invitation, ...input });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.invitations.find((item) => item.content === (input.content ?? invitation.content))!;
}

test('云端首次访问生成私密令牌，后续状态不重复返回令牌，数据库只存哈希', (t) => {
  const app = fixture(t);
  const client = app.client();
  const result = client.request('/api/state');
  assert.equal(result.status, 200);
  assert.match(result.sessionToken ?? '', /^[A-Za-z0-9_-]{43}$/u);
  assert.ok(!JSON.stringify(result.body).includes(result.sessionToken!));
  assert.deepEqual(result.body.invitations, []);
  assert.deepEqual(result.body.claims, []);
  assert.deepEqual(result.body.activities, []);
  assert.equal(result.body.stats.members, 1);
  const next = client.request('/api/state');
  assert.equal(next.sessionToken, undefined);
  assert.equal(next.body.user.id, result.body.user.id);
  const sessions = app.database.prepare('SELECT * FROM sessions').all();
  assert.ok(!JSON.stringify(sessions).includes(result.sessionToken!));
});

test('云端双用户分享、领取、反馈、确认，状态与本地契约相同', (t) => {
  const app = fixture(t);
  const owner = app.client();
  const member = app.client();
  owner.state();
  member.state();
  assert.equal(owner.request('/api/profile', 'PATCH', { name: '云端分享者' }).status, 200);
  assert.equal(member.request('/api/profile', 'PATCH', { name: '云端领取者' }).status, 200);
  const shared = publish(owner);
  const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  assert.equal(claimed.status, 201);
  const claim = claimed.body.claims[0];
  assert.equal(claim.status, 'reserved');
  assert.equal(claim.invitation.content, invitation.content);
  assert.equal(claimed.body.stats.confirmedClaims, 0);
  const submitted = member.request(`/api/claims/${claim.id}/feedback`, 'POST', { result: 'submitted', note: '已提交申请' });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.claims[0].status, 'submitted');
  assert.equal(submitted.body.stats.confirmedClaims, 0);
  const confirmed = owner.request(`/api/claims/${claim.id}/review`, 'POST', { decision: 'confirm', note: '已经核对' });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.claims[0].status, 'confirmed');
  assert.equal(confirmed.body.invitations[0].remaining, 0);
  assert.equal(confirmed.body.invitations[0].confirmedCount, 1);
  assert.equal(confirmed.body.stats.confirmedClaims, 1);
  assert.equal(confirmed.body.activities.filter((item) => item.kind === 'confirmed').length, 1);
});

test('云端公开状态隐藏完整邀请码、链接私密参数和私人反馈', (t) => {
  const app = fixture(t);
  const owner = app.client();
  const member = app.client();
  const stranger = app.client();
  owner.state();
  member.state();
  stranger.state();
  const shared = publish(owner);
  publish(owner, { kind: 'link', content: 'https://muse.ai/custom-path?token=PrivateCloudToken' });
  const publicState = stranger.state();
  assert.ok(!JSON.stringify(publicState).includes(invitation.content));
  assert.ok(!JSON.stringify(publicState).includes('PrivateCloudToken'));
  const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'invalid', note: '只有当事人可见' });
  assert.deepEqual(stranger.state().claims, []);
  assert.ok(!JSON.stringify(stranger.state()).includes('只有当事人可见'));
  assert.equal(owner.state().claims[0].feedbackNote, '只有当事人可见');
  owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'reject', note: '已经核对' });
  assert.equal(member.state().invitations.find((item) => item.id === shared.id)!.content, undefined);
  assert.equal(member.state().claims[0].invitation.content, undefined);
});

test('云端无会话、伪造令牌或错误 CSRF 不能写入，也不自动替换已有坏令牌', (t) => {
  const app = fixture(t);
  const client = app.client();
  assert.equal(client.request('/api/invitations', 'POST', invitation).status, 401);
  client.state();
  assert.equal(client.request('/api/invitations', 'POST', invitation, { csrfToken: 'wrong' }).status, 403);
  assert.equal(client.request('/api/invitations', 'POST', invitation, { sessionToken: 'a'.repeat(43) }).status, 401);
  const badSession = client.request('/api/state', 'GET', undefined, { sessionToken: 'a'.repeat(43) });
  assert.equal(badSession.status, 401);
  assert.equal(badSession.sessionToken, undefined);
  assert.deepEqual(client.state().invitations, []);
});

test('云端忽略客户端身份字段，冒充与跨身份审核被拒绝', (t) => {
  const app = fixture(t);
  const owner = app.client();
  const member = app.client();
  const stranger = app.client();
  const ownerState = owner.state();
  const memberState = member.state();
  stranger.state();
  const shared = owner.request('/api/invitations', 'POST', { ...invitation, ownerId: memberState.user.id }).body.invitations[0];
  assert.equal(shared.ownerId, ownerState.user.id);
  assert.equal(owner.request(`/api/invitations/${shared.id}/claim`, 'POST', {}).status, 409);
  assert.equal(stranger.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'close' }).status, 403);
  const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', { claimantId: ownerState.user.id });
  const claim = claimed.body.claims[0];
  assert.equal(claim.claimantId, memberState.user.id);
  assert.equal(stranger.request(`/api/claims/${claim.id}/feedback`, 'POST', { result: 'submitted', note: '' }).status, 403);
  assert.equal(owner.request(`/api/claims/${claim.id}/cancel`, 'POST', {}).status, 403);
  member.request(`/api/claims/${claim.id}/feedback`, 'POST', { result: 'submitted', note: '' });
  assert.equal(member.request(`/api/claims/${claim.id}/review`, 'POST', { decision: 'confirm', note: '' }).status, 403);
  assert.equal(stranger.request(`/api/claims/${claim.id}/review`, 'POST', { decision: 'confirm', note: '' }).status, 403);
});

test('云端同步事务防止最后名额超领，重复领取不增加占用', async (t) => {
  const app = fixture(t);
  const owner = app.client();
  const first = app.client();
  const second = app.client();
  owner.state();
  first.state();
  second.state();
  const shared = publish(owner);
  const responses = await Promise.all([
    Promise.resolve().then(() => first.request(`/api/invitations/${shared.id}/claim`, 'POST', {})),
    Promise.resolve().then(() => second.request(`/api/invitations/${shared.id}/claim`, 'POST', {})),
  ]);
  assert.deepEqual(responses.map((item) => item.status).sort(), [201, 409]);
  const state = owner.state();
  assert.equal(state.claims.length, 1);
  assert.equal(state.invitations[0].remaining, 0);
  assert.equal(state.invitations[0].status, 'full');
});

test('云端取消释放名额并隐藏私密内容，允许重新领取', (t) => {
  const app = fixture(t);
  const owner = app.client();
  const member = app.client();
  owner.state();
  member.state();
  const shared = publish(owner, { capacity: 2 });
  const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  assert.equal(member.request(`/api/invitations/${shared.id}/claim`, 'POST', {}).status, 409);
  assert.equal(owner.state().invitations[0].remaining, 1);
  const cancelled = member.request(`/api/claims/${claimId}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.claims[0].status, 'cancelled');
  assert.equal(cancelled.body.invitations[0].remaining, 2);
  assert.equal(cancelled.body.invitations[0].content, undefined);
  assert.equal(member.request(`/api/claims/${claimId}/cancel`, 'POST', {}).status, 409);
  assert.equal(member.request(`/api/invitations/${shared.id}/claim`, 'POST', {}).status, 201);
});

test('云端无效反馈保留占用，拒绝需说明原因并释放名额', (t) => {
  const app = fixture(t);
  const owner = app.client();
  const member = app.client();
  owner.state();
  member.state();
  const shared = publish(owner);
  const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  assert.equal(member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'invalid', note: '  ' }).status, 400);
  const invalid = member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'invalid', note: '提示无效' });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.invitations[0].pendingCount, 1);
  assert.equal(invalid.body.invitations[0].remaining, 0);
  assert.equal(owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' }).status, 409);
  assert.equal(owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'reject', note: '' }).status, 400);
  const rejected = owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'reject', note: '核对后释放' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.invitations[0].remaining, 1);
  assert.equal(rejected.body.claims[0].status, 'rejected');
  assert.equal(member.request(`/api/invitations/${shared.id}/claim`, 'POST', {}).status, 201);
});

test('云端确认只记一次，已确认领取不可取消或重复反馈', (t) => {
  const app = fixture(t);
  const owner = app.client();
  const member = app.client();
  owner.state();
  member.state();
  const shared = publish(owner);
  const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  assert.equal(owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' }).status, 409);
  member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'submitted', note: '' });
  assert.equal(member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'submitted', note: '' }).status, 409);
  owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' });
  assert.equal(owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' }).status, 409);
  assert.equal(owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'reject', note: '重复拒绝' }).status, 409);
  assert.equal(member.request(`/api/claims/${claimId}/cancel`, 'POST', {}).status, 409);
  assert.equal(member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'invalid', note: '重复反馈' }).status, 409);
  assert.equal(owner.state().stats.confirmedClaims, 1);
  assert.equal(owner.state().activities.filter((item) => item.kind === 'confirmed').length, 1);
});

test('云端暂停、恢复、关闭、到期规则与本地一致，已领记录仍可确认', (t) => {
  let currentDate = new Date('2026-09-28T00:00:00.000Z');
  const app = fixture(t, () => currentDate);
  const owner = app.client();
  const member = app.client();
  const stranger = app.client();
  owner.state();
  member.state();
  stranger.state();
  const shared = publish(owner, { capacity: 2, expiresInDays: 1 });
  assert.equal(shared.expiresAt, '2026-09-29T00:00:00.000Z');
  assert.equal(owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'pause' }).body.invitations[0].status, 'paused');
  assert.equal(member.request(`/api/invitations/${shared.id}/claim`, 'POST', {}).status, 409);
  assert.equal(owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'resume' }).status, 200);
  const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  currentDate = new Date('2026-09-29T00:00:00.000Z');
  assert.equal(owner.state().invitations[0].status, 'expired');
  assert.equal(stranger.request(`/api/invitations/${shared.id}/claim`, 'POST', {}).status, 409);
  assert.equal(owner.state().stats.remainingSlots, 0);
  assert.equal(owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'close' }).body.invitations[0].status, 'closed');
  assert.equal(owner.request(`/api/invitations/${shared.id}`, 'PATCH', { action: 'resume' }).status, 409);
  const claimId = claimed.body.claims[0].id;
  assert.equal(member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'submitted', note: '' }).status, 200);
  assert.equal(owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' }).status, 200);
});

test('云端输入校验保持昵称、容量、备注限制和 HTTPS Muse 域名限制', (t) => {
  const app = fixture(t);
  const owner = app.client();
  owner.state();
  for (const input of [{ capacity: 0 }, { capacity: 21 }, { capacity: 1.5 }, { expiresInDays: 31 }, { content: 'abc' }, { content: 'A'.repeat(121) }, { note: '字'.repeat(161) }]) {
    assert.equal(owner.request('/api/invitations', 'POST', { ...invitation, ...input }).status, 400);
  }
  for (const name of ['a', 'A'.repeat(17), '用\u0000户']) assert.equal(owner.request('/api/profile', 'PATCH', { name }).status, 400);
  for (const content of ['http://muse.ai/invite', 'https://muse.ai.evil.example/invite', 'https://user:pass@muse.ai/invite', 'https://muse.ai:8443/invite', 'https://muse.ai\\@evil.example/invite']) {
    assert.equal(owner.request('/api/invitations', 'POST', { ...invitation, kind: 'link', content }).status, 400);
  }
  assert.equal(publish(owner, { kind: 'link', content: 'https://app.muse.ai/real-path?token=KeepCase' }).content, 'https://app.muse.ai/real-path?token=KeepCase');
  assert.equal(owner.request('/api/not-found').status, 404);
});

test('云端核心重启后令牌身份、分享、领取、反馈和限流仍然持久化', (t) => {
  const app = fixture(t);
  const owner = app.client();
  const member = app.client();
  const before = owner.state();
  member.state();
  owner.request('/api/profile', 'PATCH', { name: '重启后的身份' });
  const shared = publish(owner);
  const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
  const claimId = claimed.body.claims[0].id;
  member.request(`/api/claims/${claimId}/feedback`, 'POST', { result: 'submitted', note: '云端重启前反馈' });
  app.restart();
  const restored = owner.state();
  assert.equal(restored.user.id, before.user.id);
  assert.equal(restored.user.name, '重启后的身份');
  assert.equal(restored.invitations[0].content, invitation.content);
  assert.equal(restored.claims[0].feedbackNote, '云端重启前反馈');
  assert.equal(member.state().claims[0].id, claimId);
  assert.equal(owner.request(`/api/claims/${claimId}/review`, 'POST', { decision: 'confirm', note: '' }).status, 200);
  assert.ok(app.database.prepare('SELECT COUNT(*) AS count FROM rate_limits').get()!.count as number > 0);
});

test('云端会话、发布和领取保留限流，取消始终可以释放名额', (t) => {
  const app = fixture(t);
  const owner = app.client();
  const member = app.client();
  owner.state();
  member.state();
  const shared = publish(owner);
  for (let index = 0; index < 30; index++) {
    const claimed = member.request(`/api/invitations/${shared.id}/claim`, 'POST', {});
    assert.equal(claimed.status, 201);
    const claimId = claimed.body.claims.find((item) => item.status === 'reserved')!.id;
    assert.equal(member.request(`/api/claims/${claimId}/cancel`, 'POST', {}).status, 200);
  }
  assert.equal(member.request(`/api/invitations/${shared.id}/claim`, 'POST', {}).status, 429);
  assert.equal(owner.state().invitations[0].remaining, 1);
  for (let index = 1; index < 10; index++) publish(owner, { content: `Cloud-code-${index}` });
  assert.equal(owner.request('/api/invitations', 'POST', invitation).status, 429);
  let limited = false;
  for (let index = 0; index < 35; index++) if (app.client().request('/api/state').status === 429) limited = true;
  assert.equal(limited, true);
});
