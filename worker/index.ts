import { DurableObject } from 'cloudflare:workers';
import { createCommunityCore, type SqlDatabase } from './core.ts';
import type { RpcInput, RpcResult } from './contracts.ts';
import { handleRequest } from './http.ts';

export interface Env {
  COMMUNITY: DurableObjectNamespace<MuseCommunity>;
  ALLOWED_ORIGIN: string;
  COMMUNITY_ID: string;
}

export class MuseCommunity extends DurableObject<Env> {
  private readonly core: ReturnType<typeof createCommunityCore>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    const database: SqlDatabase = {
      query<T>(sql: string, ...values: (string | number | null)[]) {
        return storage.sql.exec(sql, ...values).toArray() as unknown as T[];
      },
      run(sql, ...values) { storage.sql.exec(sql, ...values).toArray(); },
      transaction<T>(operation: () => T): T { return storage.transactionSync(operation); },
    };
    this.core = createCommunityCore(database);
  }

  handle(input: RpcInput): RpcResult {
    return this.core.handle(input);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      allowedOrigin: env.ALLOWED_ORIGIN,
      dispatch: async (input) => env.COMMUNITY.getByName(env.COMMUNITY_ID).handle(input),
    });
  },
} satisfies ExportedHandler<Env>;
