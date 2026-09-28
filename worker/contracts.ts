import type { CommunityState } from '../shared/types.ts';

export interface RpcInput {
  method: string;
  path: string;
  sessionToken?: string;
  csrfToken?: string;
  ip: string;
  body?: unknown;
}

export interface RpcResult {
  status: number;
  body: CommunityState | { error: string } | { ok: true };
  sessionToken?: string;
}
