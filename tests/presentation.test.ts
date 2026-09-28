import assert from 'node:assert/strict';
import test from 'node:test';
import type { Invitation } from '../shared/types.ts';
import { filterInvitations, relativeTime } from '../src/lib/presentation.ts';

const invitation = (overrides: Partial<Invitation>): Invitation => ({
  id: 'first', ownerId: 'alice', ownerName: '小林', kind: 'code',
  preview: 'MUS*****', note: '还有一个名额', capacity: 1, remaining: 1,
  confirmedCount: 0, pendingCount: 0, status: 'available',
  createdAt: '2026-09-27T10:00:00.000Z', expiresAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

test('搜索按昵称和备注匹配，不暴露私密邀请码', () => {
  const items = [invitation({ content: 'PRIVATE-SECRET' }), invitation({ id: 'second', ownerName: '阿青', note: '英文邀请' })];
  assert.deepEqual(filterInvitations(items, { query: '英文', filter: 'all', sort: 'newest' }).map(item => item.id), ['second']);
  assert.deepEqual(filterInvitations(items, { query: 'private-secret', filter: 'all', sort: 'newest' }), []);
});

test('只看可领取时排除已暂停、过期和名额已满的分享', () => {
  const items = [invitation({}), invitation({ id: 'paused', status: 'paused' }), invitation({ id: 'expired', status: 'expired' }), invitation({ id: 'full', status: 'full', remaining: 0 })];
  assert.deepEqual(filterInvitations(items, { query: '', filter: 'available', sort: 'newest' }).map(item => item.id), ['first']);
});

test('按最早到期排序，搜索前后的原始记录不被修改', () => {
  const items = [invitation({}), invitation({ id: 'second', expiresAt: '2026-09-29T10:00:00.000Z' })];
  assert.deepEqual(filterInvitations(items, { query: '', filter: 'all', sort: 'ending' }).map(item => item.id), ['second', 'first']);
  assert.equal(items[0].id, 'first');
});

test('相对时间正确处理刚发生和未来时钟，不出现负时间', () => {
  const now = Date.parse('2026-09-28T10:00:00.000Z');
  assert.equal(relativeTime('2026-09-28T09:58:00.000Z', now), '2 分钟前');
  assert.equal(relativeTime('2026-09-28T10:01:00.000Z', now), '刚刚');
});
