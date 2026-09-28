import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import type { Request, Response } from 'express';
import { createApp } from './server/app';

export default defineConfig({
  base: process.env.PAGES_BASE || '/',
  plugins: [
    react(),
    {
      name: 'muse-community-api',
      apply: 'serve',
      configureServer(server) {
        const backend = createApp({ databasePath: path.resolve(process.env.DATABASE_PATH || 'data/muse.sqlite') });
        server.middlewares.use((request, response, next) => {
          if (request.url?.startsWith('/api/')) backend.app(request as Request, response as Response, next);
          else next();
        });
        server.httpServer?.once('close', () => backend.close());
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5173 },
});
