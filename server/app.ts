import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Activity, Claim, ClaimStatus, CommunityState, Invitation, InvitationKind, InvitationStatus, User } from '../shared/types.ts';

const day = 86_400_000;
const hour = 3_600_000;
const occupiedStatuses = new Set<ClaimStatus>(['reserved', 'submitted', 'invalid', 'confirmed']);
const cookieName = 'muse_session';

interface Session {
  userId: string;
  csrfToken: string;
}

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
  constructor(public status: number, message: string) {
    super(message);
  }
}

function textField(maximum: number, label: string, minimum = 0) {
  return z.string({ required_error: `请填写${label}`, invalid_type_error: `${label}格式不正确` })
    .trim()
    .refine((value) => Array.from(value).length >= minimum && Array.from(value).length <= maximum, `${label}需要 ${minimum} 至 ${maximum} 个字符`)
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), `${label}包含无效字符`);
}

const profileSchema = z.object({ name: textField(16, '昵称', 2).refine((value) => !/[\r\n\t]/u.test(value), '昵称不能包含换行') });
const publishSchema = z.object({
  kind: z.enum(['code', 'link'], { errorMap: () => ({ message: '请选择邀请码或邀请链接' }) }),
  content: textField(2048, '邀请内容', 4),
  note: textField(160, '备注').default(''),
  capacity: z.number().int('可邀请次数必须是整数').min(1, '可邀请次数至少为 1').max(20, '可邀请次数最多为 20'),
  expiresInDays: z.number().int('有效天数必须是整数').min(1, '有效天数至少为 1').max(30, '有效天数最多为 30'),
});
const invitationActionSchema = z.object({ action: z.enum(['pause', 'resume', 'close']) });
const feedbackSchema = z.object({ result: z.enum(['submitted', 'invalid']), note: textField(240, '反馈说明').default('') })
  .refine((value) => value.result !== 'invalid' || value.note.length > 0, '请说明邀请码无效的原因');
const reviewSchema = z.object({ decision: z.enum(['confirm', 'reject']), note: textField(240, '审核说明').default('') })
  .refine((value) => value.decision !== 'reject' || value.note.length > 0, '请说明拒绝确认的原因');

function validate<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '请求格式不正确');
  return parsed.data;
}

function validateContent(kind: InvitationKind, content: string) {
  if (kind === 'code') {
    if (Array.from(content).length > 120 || /[\r\n\t]/u.test(content)) throw new ApiError(400, '邀请码需要 4 至 120 个字符，且不能包含换行');
    return;
  }
  let url: URL;
  try {
    url = new URL(content);
  } catch {
    throw new ApiError(400, '请输入有效的 Muse 邀请链接');
  }
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

export function createApp(options: { databasePath: string; now?: () => Date }) {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const database = new DatabaseSync(options.databasePath);
  const now = options.now ?? (() => new Date());
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('code', 'link')),
      content TEXT NOT NULL,
      note TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 20),
      state TEXT NOT NULL CHECK (state IN ('available', 'paused', 'closed')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      invitation_id TEXT NOT NULL REFERENCES invitations(id),
      claimant_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'submitted', 'confirmed', 'invalid', 'cancelled', 'rejected')),
      feedback_note TEXT NOT NULL DEFAULT '',
      owner_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS claims_one_active_per_user ON claims(invitation_id, claimant_id)
      WHERE status IN ('reserved', 'submitted', 'invalid', 'confirmed');
    CREATE INDEX IF NOT EXISTS claims_claimant ON claims(claimant_id);
    CREATE INDEX IF NOT EXISTS invitations_owner ON invitations(owner_id);
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('shared', 'claimed', 'confirmed')),
      actor_id TEXT NOT NULL REFERENCES users(id),
      invitation_id TEXT NOT NULL REFERENCES invitations(id),
      claim_id TEXT UNIQUE REFERENCES claims(id),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      hits INTEGER NOT NULL
    ) STRICT;
  `);

  const invitationsQuery = `
    SELECT i.*, u.name AS owner_name,
      COALESCE(SUM(c.status = 'confirmed'), 0) AS confirmed_count,
      COALESCE(SUM(c.status IN ('reserved', 'submitted', 'invalid')), 0) AS pending_count
    FROM invitations i JOIN users u ON u.id = i.owner_id
    LEFT JOIN claims c ON c.invitation_id = i.id
  `;

  function transaction<T>(operation: () => T): T {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function rateLimit(key: string, maximum: number) {
    const timestamp = now().getTime();
    database.prepare('DELETE FROM rate_limits WHERE window_start <= ?').run(timestamp - hour);
    const existing = database.prepare('SELECT window_start, hits FROM rate_limits WHERE key = ?').get(key) as { window_start: number; hits: number } | undefined;
    if (existing && existing.hits >= maximum) throw new ApiError(429, '操作过于频繁，请一小时后重试');
    database.prepare(`INSERT INTO rate_limits(key, window_start, hits) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET hits = hits + 1`).run(key, timestamp);
  }

  function readSession(request: Request): Session | undefined {
    const cookie = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`));
    const token = cookie?.slice(cookieName.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const row = database.prepare('SELECT user_id, csrf_token FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(createHash('sha256').update(token).digest('hex'), now().toISOString()) as { user_id: string; csrf_token: string } | undefined;
    return row ? { userId: row.user_id, csrfToken: row.csrf_token } : undefined;
  }

  function createSession(request: Request, response: Response): Session {
    const session = transaction(() => {
      rateLimit(`session:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`, 30);
      const userId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const createdAt = now();
      database.prepare('INSERT INTO users(id, name, created_at) VALUES (?, ?, ?)')
        .run(userId, `邻居${randomBytes(3).toString('hex')}`, createdAt.toISOString());
      database.prepare('INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
        .run(createHash('sha256').update(token).digest('hex'), userId, csrfToken, new Date(createdAt.getTime() + 365 * day).toISOString());
      return { userId, csrfToken, token };
    });
    response.cookie(cookieName, session.token, { httpOnly: true, sameSite: 'lax', secure: request.secure, path: '/', maxAge: 365 * day });
    return { userId: session.userId, csrfToken: session.csrfToken };
  }

  function invitationById(id: string): InvitationRow {
    const row = database.prepare(`${invitationsQuery} WHERE i.id = ? GROUP BY i.id`).get(id) as unknown as InvitationRow | undefined;
    if (!row) throw new ApiError(404, '这条分享不存在');
    return row;
  }

  function claimById(id: string): ClaimRow {
    const row = database.prepare(`SELECT c.*, u.name AS claimant_name, i.owner_id FROM claims c
      JOIN invitations i ON i.id = c.invitation_id JOIN users u ON u.id = c.claimant_id WHERE c.id = ?`)
      .get(id) as unknown as ClaimRow | undefined;
    if (!row) throw new ApiError(404, '这条领取记录不存在');
    return row;
  }

  function activity(kind: Activity['kind'], userId: string, invitationId: string, claimId: string | null = null) {
    database.prepare('INSERT INTO activities(id, kind, actor_id, invitation_id, claim_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), kind, userId, invitationId, claimId, now().toISOString());
  }

  function readState(session: Session): CommunityState {
    const userRow = database.prepare('SELECT id, name, created_at FROM users WHERE id = ?').get(session.userId) as { id: string; name: string; created_at: string };
    const user: User = { id: userRow.id, name: userRow.name, createdAt: userRow.created_at };
    const invitationRows = database.prepare(`${invitationsQuery} GROUP BY i.id ORDER BY i.created_at DESC, i.id DESC`).all() as unknown as InvitationRow[];
    const claimRows = database.prepare(`SELECT c.*, u.name AS claimant_name, i.owner_id FROM claims c
      JOIN invitations i ON i.id = c.invitation_id JOIN users u ON u.id = c.claimant_id
      WHERE c.claimant_id = ? OR i.owner_id = ? ORDER BY c.created_at DESC, c.id DESC`)
      .all(user.id, user.id) as unknown as ClaimRow[];
    const accessibleInvitations = new Set(claimRows.filter((claim) => claim.claimant_id === user.id && occupiedStatuses.has(claim.status)).map((claim) => claim.invitation_id));
    const timestamp = now().getTime();
    const invitations: Invitation[] = invitationRows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      kind: row.kind,
      preview: row.kind === 'code' ? '********' : 'https://muse.ai/...',
      ...(row.owner_id === user.id || accessibleInvitations.has(row.id) ? { content: row.content } : {}),
      note: row.note,
      capacity: row.capacity,
      remaining: Math.max(0, row.capacity - row.confirmed_count - row.pending_count),
      confirmedCount: row.confirmed_count,
      pendingCount: row.pending_count,
      status: statusOf(row, timestamp),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
    const invitationMap = new Map(invitations.map((item) => [item.id, item]));
    const claims: Claim[] = claimRows.map((row) => ({
      id: row.id,
      invitationId: row.invitation_id,
      claimantId: row.claimant_id,
      claimantName: row.claimant_name,
      status: row.status,
      feedbackNote: row.feedback_note,
      ownerNote: row.owner_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      invitation: invitationMap.get(row.invitation_id)!,
    }));
    const activityRows = database.prepare(`SELECT a.id, a.kind, u.name, a.invitation_id, a.created_at
      FROM activities a JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 100`)
      .all() as unknown as { id: string; kind: Activity['kind']; name: string; invitation_id: string; created_at: string }[];
    const available = invitations.filter((item) => item.status === 'available');
    const memberCount = database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    const confirmedCount = database.prepare("SELECT COUNT(*) AS count FROM claims WHERE status = 'confirmed'").get() as { count: number };
    return {
      user,
      csrfToken: session.csrfToken,
      invitations,
      claims,
      activities: activityRows.map((row) => ({ id: row.id, kind: row.kind, name: row.name, invitationId: row.invitation_id, createdAt: row.created_at })),
      stats: { availableInvitations: available.length, remainingSlots: available.reduce((total, item) => total + item.remaining, 0), confirmedClaims: confirmedCount.count, members: memberCount.count },
    };
  }

  const app = express();
  app.disable('x-powered-by');
  const api = express.Router();
  api.use((_request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    next();
  });
  api.use(express.json({ limit: '12kb' }));
  api.use((request, response, next) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return next();
    const session = readSession(request);
    if (!session) throw new ApiError(401, '请先打开页面建立会话，再重试');
    const suppliedCsrf = request.get('x-csrf-token') ?? '';
    const expected = Buffer.from(session.csrfToken);
    const supplied = Buffer.from(suppliedCsrf);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ApiError(403, '页面会话已变化，请刷新后重试');
    const origin = request.get('origin');
    if (origin !== undefined) {
      let parsed: URL;
      try { parsed = new URL(origin); } catch { throw new ApiError(403, '不允许跨站提交'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== request.get('host') || parsed.username || parsed.password) throw new ApiError(403, '不允许跨站提交');
    }
    response.locals.session = session;
    next();
  });

  const sessionFor = (response: Response) => response.locals.session as Session;
  const respond = (response: Response, status = 200) => response.status(status).json(readState(sessionFor(response)));

  api.get('/state', (request, response) => {
    const session = readSession(request) ?? createSession(request, response);
    response.json(readState(session));
  });

  api.patch('/profile', (request, response) => {
    const input = validate(profileSchema, request.body);
    database.prepare('UPDATE users SET name = ? WHERE id = ?').run(input.name, sessionFor(response).userId);
    respond(response);
  });

  api.post('/invitations', (request, response) => {
    const input = validate(publishSchema, request.body);
    validateContent(input.kind, input.content);
    const session = sessionFor(response);
    transaction(() => {
      rateLimit(`publish:user:${session.userId}`, 10);
      rateLimit(`publish:ip:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`, 20);
      const createdAt = now();
      const id = randomUUID();
      database.prepare(`INSERT INTO invitations(id, owner_id, kind, content, note, capacity, state, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)`)
        .run(id, session.userId, input.kind, input.content, input.note, input.capacity, createdAt.toISOString(), new Date(createdAt.getTime() + input.expiresInDays * day).toISOString());
      activity('shared', session.userId, id);
    });
    respond(response, 201);
  });

  api.patch('/invitations/:id', (request, response) => {
    const input = validate(invitationActionSchema, request.body);
    transaction(() => {
      const invitation = invitationById(request.params.id as string);
      if (invitation.owner_id !== sessionFor(response).userId) throw new ApiError(403, '只有分享者可以管理这条分享');
      if (invitation.state === 'closed') throw new ApiError(409, '这条分享已经关闭');
      const nextState = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'available' : 'closed';
      if (invitation.state === nextState) throw new ApiError(409, '分享已经处于这个状态');
      database.prepare('UPDATE invitations SET state = ? WHERE id = ?').run(nextState, invitation.id);
    });
    respond(response);
  });

  api.post('/invitations/:id/claim', (request, response) => {
    const session = sessionFor(response);
    transaction(() => {
      const invitation = invitationById(request.params.id as string);
      if (invitation.owner_id === session.userId) throw new ApiError(409, '不能领取自己分享的邀请码');
      if (statusOf(invitation, now().getTime()) !== 'available') throw new ApiError(409, '这条分享目前不可领取，请刷新查看状态');
      const previous = database.prepare(`SELECT id FROM claims WHERE invitation_id = ? AND claimant_id = ?
        AND status IN ('reserved', 'submitted', 'invalid', 'confirmed')`).get(invitation.id, session.userId);
      if (previous) throw new ApiError(409, '你已经领取过这条分享，请先处理已有记录');
      rateLimit(`claim:user:${session.userId}`, 30);
      rateLimit(`claim:ip:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`, 100);
      const id = randomUUID();
      const createdAt = now().toISOString();
      database.prepare(`INSERT INTO claims(id, invitation_id, claimant_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'reserved', ?, ?)`).run(id, invitation.id, session.userId, createdAt, createdAt);
      activity('claimed', session.userId, invitation.id);
    });
    respond(response, 201);
  });

  api.post('/claims/:id/feedback', (request, response) => {
    const input = validate(feedbackSchema, request.body);
    transaction(() => {
      const claim = claimById(request.params.id as string);
      if (claim.claimant_id !== sessionFor(response).userId) throw new ApiError(403, '只有领取人可以提交反馈');
      if (claim.status !== 'reserved') throw new ApiError(409, '这条记录已经反馈或结束，请刷新查看状态');
      database.prepare('UPDATE claims SET status = ?, feedback_note = ?, updated_at = ? WHERE id = ?')
        .run(input.result, input.note, now().toISOString(), claim.id);
    });
    respond(response);
  });

  api.post('/claims/:id/cancel', (request, response) => {
    transaction(() => {
      const claim = claimById(request.params.id as string);
      if (claim.claimant_id !== sessionFor(response).userId) throw new ApiError(403, '只有领取人可以取消领取');
      if (!['reserved', 'submitted', 'invalid'].includes(claim.status)) throw new ApiError(409, '这条领取记录不能取消');
      database.prepare("UPDATE claims SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now().toISOString(), claim.id);
    });
    respond(response);
  });

  api.post('/claims/:id/review', (request, response) => {
    const input = validate(reviewSchema, request.body);
    transaction(() => {
      const claim = claimById(request.params.id as string);
      if (claim.owner_id !== sessionFor(response).userId) throw new ApiError(403, '只有分享者可以确认结果');
      if (input.decision === 'confirm' ? claim.status !== 'submitted' : !['submitted', 'invalid'].includes(claim.status)) throw new ApiError(409, '这条记录当前不能审核，请刷新查看状态');
      database.prepare('UPDATE claims SET status = ?, owner_note = ?, updated_at = ? WHERE id = ?')
        .run(input.decision === 'confirm' ? 'confirmed' : 'rejected', input.note, now().toISOString(), claim.id);
      if (input.decision === 'confirm') activity('confirmed', claim.claimant_id, claim.invitation_id, claim.id);
    });
    respond(response);
  });

  api.use((_request, response) => response.status(404).json({ error: '接口不存在' }));
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof ApiError) {
      if (error.status === 429) response.set('Retry-After', '3600');
      response.status(error.status).json({ error: error.message });
    } else if (error?.type === 'entity.parse.failed') {
      response.status(400).json({ error: '请求内容不是有效的 JSON' });
    } else if (error?.type === 'entity.too.large') {
      response.status(413).json({ error: '提交的内容过长' });
    } else {
      console.error('API request failed', error);
      response.status(500).json({ error: '服务暂时无法处理请求，请稍后重试' });
    }
  };
  api.use(errors);
  app.use('/api', api);
  return { app, close: () => database.close() };
}
