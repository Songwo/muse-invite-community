import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { Activity, Claim, ClaimStatus, CommunityState, Invitation, InvitationKind, InvitationStatus } from '../shared/types.ts';
import type { RpcInput, RpcResult } from './contracts.ts';

export type SqlValue = string | number | null;

export interface SqlDatabase {
  query<T>(sql: string, ...values: SqlValue[]): T[];
  run(sql: string, ...values: SqlValue[]): void;
  transaction<T>(operation: () => T): T;
}

interface Session { userId: string; csrfToken: string }
interface InvitationRow {
  id: string;
  owner_id: string;
  owner_name: string;
  kind: InvitationKind;
  content: string;
  note: string;
  capacity: number;
  state: 'available' | 'paused' | 'closed';
  created_at: string;
  expires_at: string;
  confirmed_count: number;
  pending_count: number;
}
interface ClaimRow {
  id: string;
  invitation_id: string;
  claimant_id: string;
  claimant_name: string;
  status: ClaimStatus;
  feedback_note: string;
  owner_note: string;
  created_at: string;
  updated_at: string;
  owner_id: string;
}

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const day = 86_400_000;
const hour = 3_600_000;
const occupiedStatuses = new Set<ClaimStatus>(['reserved', 'submitted', 'invalid', 'confirmed']);

function textField(maximum: number, label: string, minimum = 0) {
  return z.string({ required_error: `请填写${label}`, invalid_type_error: `${label}格式不正确` }).trim()
    .refine((value) => Array.from(value).length >= minimum && Array.from(value).length <= maximum, `${label}需要 ${minimum} 至 ${maximum} 个字符`)
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), `${label}包含无效字符`);
}
const profileSchema = z.object({ name: textField(16, '昵称', 2).refine((value) => !/[\r\n\t]/u.test(value), '昵称不能包含换行') });
const publishSchema = z.object({
  kind: z.enum(['code', 'link']),
  content: textField(2048, '邀请内容', 4),
  note: textField(160, '备注').default(''),
  capacity: z.number().int('可邀请次数必须是整数').min(1, '可邀请次数至少为 1').max(20, '可邀请次数最多为 20'),
  expiresInDays: z.number().int('有效天数必须是整数').min(1, '有效天数至少为 1').max(30, '有效天数最多为 30'),
});
const actionSchema = z.object({ action: z.enum(['pause', 'resume', 'close']) });
const feedbackSchema = z.object({ result: z.enum(['submitted', 'invalid']), note: textField(240, '反馈说明').default('') })
  .refine((value) => value.result !== 'invalid' || value.note.length > 0, '请说明邀请码无效的原因');
const reviewSchema = z.object({ decision: z.enum(['confirm', 'reject']), note: textField(240, '审核说明').default('') })
  .refine((value) => value.decision !== 'reject' || value.note.length > 0, '请说明拒绝确认的原因');

function validate<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(400, result.error.issues[0]?.message ?? '请求格式不正确');
  return result.data;
}

function validateContent(kind: InvitationKind, content: string) {
  if (kind === 'code') {
    if (Array.from(content).length > 120 || /[\r\n\t]/u.test(content)) throw new ApiError(400, '邀请码需要 4 至 120 个字符，且不能包含换行');
    return;
  }
  let url: URL;
  try { url = new URL(content); } catch { throw new ApiError(400, '请输入有效的 Muse 邀请链接'); }
  if (url.protocol !== 'https:' || (url.hostname !== 'muse.ai' && !url.hostname.endsWith('.muse.ai'))
    || url.username || url.password || url.port || /[\\\s]/u.test(content)) {
    throw new ApiError(400, '邀请链接必须使用 HTTPS Muse 域名，且不能包含登录凭证或非默认端口');
  }
}

function statusOf(invitation: InvitationRow, timestamp: number): InvitationStatus {
  if (invitation.state === 'closed' || invitation.state === 'paused') return invitation.state;
  if (Date.parse(invitation.expires_at) <= timestamp) return 'expired';
  if (invitation.confirmed_count + invitation.pending_count >= invitation.capacity) return 'full';
  return 'available';
}

const schema = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('code', 'link')), content TEXT NOT NULL, note TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 20),
    state TEXT NOT NULL CHECK (state IN ('available', 'paused', 'closed')),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES invitations(id),
    claimant_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'submitted', 'confirmed', 'invalid', 'cancelled', 'rejected')),
    feedback_note TEXT NOT NULL DEFAULT '', owner_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS claims_one_active_per_user ON claims(invitation_id, claimant_id)
    WHERE status IN ('reserved', 'submitted', 'invalid', 'confirmed')`,
  `CREATE INDEX IF NOT EXISTS claims_claimant ON claims(claimant_id)`,
  `CREATE INDEX IF NOT EXISTS invitations_owner ON invitations(owner_id)`,
  `CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('shared', 'claimed', 'confirmed')),
    actor_id TEXT NOT NULL REFERENCES users(id), invitation_id TEXT NOT NULL REFERENCES invitations(id),
    claim_id TEXT UNIQUE REFERENCES claims(id), created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL) STRICT`,
];

export function createCommunityCore(database: SqlDatabase, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  database.transaction(() => schema.forEach((sql) => database.run(sql)));

  const invitationQuery = `SELECT i.*, u.name AS owner_name,
    COALESCE(SUM(c.status = 'confirmed'), 0) AS confirmed_count,
    COALESCE(SUM(c.status IN ('reserved', 'submitted', 'invalid')), 0) AS pending_count
    FROM invitations i JOIN users u ON u.id = i.owner_id LEFT JOIN claims c ON c.invitation_id = i.id`;

  function rateLimit(key: string, maximum: number) {
    const timestamp = now().getTime();
    database.run('DELETE FROM rate_limits WHERE window_start <= ?', timestamp - hour);
    const existing = database.query<{ hits: number }>('SELECT hits FROM rate_limits WHERE key = ?', key)[0];
    if (existing && existing.hits >= maximum) throw new ApiError(429, '操作过于频繁，请一小时后重试');
    database.run(`INSERT INTO rate_limits(key, window_start, hits) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET hits = hits + 1`, key, timestamp);
  }

  function readSession(token: string | undefined): Session | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const row = database.query<{ user_id: string; csrf_token: string }>(
      'SELECT user_id, csrf_token FROM sessions WHERE token_hash = ? AND expires_at > ?',
      createHash('sha256').update(token).digest('hex'), now().toISOString(),
    )[0];
    return row ? { userId: row.user_id, csrfToken: row.csrf_token } : undefined;
  }

  function createSession(ip: string): Session & { token: string } {
    rateLimit(`session:${ip}`, 30);
    const userId = randomUUID();
    const token = Buffer.from(randomBytes(32)).toString('base64url');
    const csrfToken = Buffer.from(randomBytes(32)).toString('base64url');
    const createdAt = now();
    database.run('INSERT INTO users(id, name, created_at) VALUES (?, ?, ?)', userId, `邻居${Buffer.from(randomBytes(3)).toString('hex')}`, createdAt.toISOString());
    database.run('INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)',
      createHash('sha256').update(token).digest('hex'), userId, csrfToken, new Date(createdAt.getTime() + 365 * day).toISOString());
    return { userId, csrfToken, token };
  }

  function requireSession(input: RpcInput): Session {
    const session = readSession(input.sessionToken);
    if (!session) throw new ApiError(401, '请重新打开页面建立会话，再重试');
    const supplied = Buffer.from(input.csrfToken ?? '');
    const expected = Buffer.from(session.csrfToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ApiError(403, '页面会话已变化，请刷新后重试');
    return session;
  }

  function invitationById(id: string): InvitationRow {
    const row = database.query<InvitationRow>(`${invitationQuery} WHERE i.id = ? GROUP BY i.id`, id)[0];
    if (!row) throw new ApiError(404, '这条分享不存在');
    return row;
  }

  function claimById(id: string): ClaimRow {
    const row = database.query<ClaimRow>(`SELECT c.*, u.name AS claimant_name, i.owner_id FROM claims c
      JOIN invitations i ON i.id = c.invitation_id JOIN users u ON u.id = c.claimant_id WHERE c.id = ?`, id)[0];
    if (!row) throw new ApiError(404, '这条领取记录不存在');
    return row;
  }

  function activity(kind: Activity['kind'], actorId: string, invitationId: string, claimId: string | null = null) {
    database.run('INSERT INTO activities(id, kind, actor_id, invitation_id, claim_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(), kind, actorId, invitationId, claimId, now().toISOString());
  }

  function readState(session: Session): CommunityState {
    const user = database.query<{ id: string; name: string; created_at: string }>('SELECT id, name, created_at FROM users WHERE id = ?', session.userId)[0];
    const invitationRows = database.query<InvitationRow>(`${invitationQuery} GROUP BY i.id ORDER BY i.created_at DESC, i.id DESC`);
    const claimRows = database.query<ClaimRow>(`SELECT c.*, u.name AS claimant_name, i.owner_id FROM claims c
      JOIN invitations i ON i.id = c.invitation_id JOIN users u ON u.id = c.claimant_id
      WHERE c.claimant_id = ? OR i.owner_id = ? ORDER BY c.created_at DESC, c.id DESC`, user.id, user.id);
    const accessible = new Set(claimRows.filter((claim) => claim.claimant_id === user.id && occupiedStatuses.has(claim.status)).map((claim) => claim.invitation_id));
    const timestamp = now().getTime();
    const invitations: Invitation[] = invitationRows.map((row) => ({
      id: row.id, ownerId: row.owner_id, ownerName: row.owner_name, kind: row.kind,
      preview: row.kind === 'code' ? '********' : 'https://muse.ai/...',
      ...(row.owner_id === user.id || accessible.has(row.id) ? { content: row.content } : {}),
      note: row.note, capacity: row.capacity,
      remaining: Math.max(0, row.capacity - row.confirmed_count - row.pending_count),
      confirmedCount: row.confirmed_count, pendingCount: row.pending_count,
      status: statusOf(row, timestamp), createdAt: row.created_at, expiresAt: row.expires_at,
    }));
    const invitationMap = new Map(invitations.map((item) => [item.id, item]));
    const claims: Claim[] = claimRows.map((row) => ({
      id: row.id, invitationId: row.invitation_id, claimantId: row.claimant_id, claimantName: row.claimant_name,
      status: row.status, feedbackNote: row.feedback_note, ownerNote: row.owner_note,
      createdAt: row.created_at, updatedAt: row.updated_at, invitation: invitationMap.get(row.invitation_id)!,
    }));
    const activityRows = database.query<{ id: string; kind: Activity['kind']; name: string; invitation_id: string; created_at: string }>(
      `SELECT a.id, a.kind, u.name, a.invitation_id, a.created_at FROM activities a JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC, a.rowid DESC LIMIT 100`,
    );
    const available = invitations.filter((item) => item.status === 'available');
    const members = database.query<{ count: number }>('SELECT COUNT(*) AS count FROM users')[0].count;
    const confirmed = database.query<{ count: number }>("SELECT COUNT(*) AS count FROM claims WHERE status = 'confirmed'")[0].count;
    return {
      user: { id: user.id, name: user.name, createdAt: user.created_at }, csrfToken: session.csrfToken, invitations, claims,
      activities: activityRows.map((row) => ({ id: row.id, kind: row.kind, name: row.name, invitationId: row.invitation_id, createdAt: row.created_at })),
      stats: { availableInvitations: available.length, remainingSlots: available.reduce((sum, item) => sum + item.remaining, 0), confirmedClaims: confirmed, members },
    };
  }

  function execute(input: RpcInput): RpcResult {
    if (input.method === 'GET' && input.path === '/api/health') return { status: 200, body: { ok: true } };
    if (input.method === 'GET' && input.path === '/api/state') {
      if (input.sessionToken !== undefined) {
        const session = readSession(input.sessionToken);
        if (!session) throw new ApiError(401, '会话已失效，请重新建立会话');
        return { status: 200, body: readState(session) };
      }
      const session = createSession(input.ip);
      return { status: 200, body: readState(session), sessionToken: session.token };
    }
    if (!['POST', 'PATCH'].includes(input.method)) throw new ApiError(404, '接口不存在');
    const session = requireSession(input);
    if (input.method === 'PATCH' && input.path === '/api/profile') {
      const body = validate(profileSchema, input.body);
      database.run('UPDATE users SET name = ? WHERE id = ?', body.name, session.userId);
      return { status: 200, body: readState(session) };
    }
    if (input.method === 'POST' && input.path === '/api/invitations') {
      const body = validate(publishSchema, input.body);
      validateContent(body.kind, body.content);
      rateLimit(`publish:user:${session.userId}`, 10);
      rateLimit(`publish:ip:${input.ip}`, 20);
      const id = randomUUID();
      const createdAt = now();
      database.run(`INSERT INTO invitations(id, owner_id, kind, content, note, capacity, state, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)`,
      id, session.userId, body.kind, body.content, body.note, body.capacity, createdAt.toISOString(), new Date(createdAt.getTime() + body.expiresInDays * day).toISOString());
      activity('shared', session.userId, id);
      return { status: 201, body: readState(session) };
    }
    const invitationRoute = input.path.match(/^\/api\/invitations\/([^/]+)(\/claim)?$/u);
    if (invitationRoute && input.method === 'PATCH' && !invitationRoute[2]) {
      const body = validate(actionSchema, input.body);
      const invitation = invitationById(invitationRoute[1]);
      if (invitation.owner_id !== session.userId) throw new ApiError(403, '只有分享者可以管理这条分享');
      if (invitation.state === 'closed') throw new ApiError(409, '这条分享已经关闭');
      const nextState = body.action === 'pause' ? 'paused' : body.action === 'resume' ? 'available' : 'closed';
      if (invitation.state === nextState) throw new ApiError(409, '分享已经处于这个状态');
      database.run('UPDATE invitations SET state = ? WHERE id = ?', nextState, invitation.id);
      return { status: 200, body: readState(session) };
    }
    if (invitationRoute && input.method === 'POST' && invitationRoute[2] === '/claim') {
      const invitation = invitationById(invitationRoute[1]);
      if (invitation.owner_id === session.userId) throw new ApiError(409, '不能领取自己分享的邀请码');
      if (statusOf(invitation, now().getTime()) !== 'available') throw new ApiError(409, '这条分享目前不可领取，请刷新查看状态');
      const existing = database.query<{ id: string }>(`SELECT id FROM claims WHERE invitation_id = ? AND claimant_id = ?
        AND status IN ('reserved', 'submitted', 'invalid', 'confirmed')`, invitation.id, session.userId)[0];
      if (existing) throw new ApiError(409, '你已经领取过这条分享，请先处理已有记录');
      rateLimit(`claim:user:${session.userId}`, 30);
      rateLimit(`claim:ip:${input.ip}`, 100);
      const createdAt = now().toISOString();
      database.run(`INSERT INTO claims(id, invitation_id, claimant_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'reserved', ?, ?)`, randomUUID(), invitation.id, session.userId, createdAt, createdAt);
      activity('claimed', session.userId, invitation.id);
      return { status: 201, body: readState(session) };
    }
    const claimRoute = input.path.match(/^\/api\/claims\/([^/]+)\/(feedback|cancel|review)$/u);
    if (claimRoute && input.method === 'POST') {
      const claim = claimById(claimRoute[1]);
      if (claimRoute[2] === 'feedback') {
        const body = validate(feedbackSchema, input.body);
        if (claim.claimant_id !== session.userId) throw new ApiError(403, '只有领取人可以提交反馈');
        if (claim.status !== 'reserved') throw new ApiError(409, '这条记录已经反馈或结束，请刷新查看状态');
        database.run('UPDATE claims SET status = ?, feedback_note = ?, updated_at = ? WHERE id = ?', body.result, body.note, now().toISOString(), claim.id);
      } else if (claimRoute[2] === 'cancel') {
        if (claim.claimant_id !== session.userId) throw new ApiError(403, '只有领取人可以取消领取');
        if (!['reserved', 'submitted', 'invalid'].includes(claim.status)) throw new ApiError(409, '这条领取记录不能取消');
        database.run("UPDATE claims SET status = 'cancelled', updated_at = ? WHERE id = ?", now().toISOString(), claim.id);
      } else {
        const body = validate(reviewSchema, input.body);
        if (claim.owner_id !== session.userId) throw new ApiError(403, '只有分享者可以确认结果');
        if (body.decision === 'confirm' ? claim.status !== 'submitted' : !['submitted', 'invalid'].includes(claim.status)) throw new ApiError(409, '这条记录当前不能审核，请刷新查看状态');
        database.run('UPDATE claims SET status = ?, owner_note = ?, updated_at = ? WHERE id = ?', body.decision === 'confirm' ? 'confirmed' : 'rejected', body.note, now().toISOString(), claim.id);
        if (body.decision === 'confirm') activity('confirmed', claim.claimant_id, claim.invitation_id, claim.id);
      }
      return { status: 200, body: readState(session) };
    }
    throw new ApiError(404, '接口不存在');
  }

  return {
    handle(input: RpcInput): RpcResult {
      try {
        // 业务校验、容量检查、记录更新和响应快照共同提交，失败则完整回滚。
        return database.transaction(() => execute(input));
      } catch (error) {
        if (error instanceof ApiError) return { status: error.status, body: { error: error.message } };
        console.error('Community request failed', error);
        return { status: 500, body: { error: '服务暂时无法处理请求，请稍后重试' } };
      }
    },
  };
}
