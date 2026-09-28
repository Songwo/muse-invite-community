import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.ts';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distPath = join(projectRoot, 'dist');
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? '127.0.0.1';

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
if (!existsSync(join(distPath, 'index.html'))) throw new Error('Frontend build is missing. Run npm run build before npm start.');

const { app, close } = createApp({ databasePath: resolve(process.env.DATABASE_PATH ?? join(projectRoot, 'data', 'muse.sqlite')) });
app.use(express.static(distPath));
app.get('/{*path}', (_request, response) => response.sendFile(join(distPath, 'index.html')));

const server = app.listen(port, host, () => {
  console.log(`Muse Invite Community is running at http://${host}:${port}`);
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close((error) => {
    close();
    if (error) {
      console.error('Server shutdown failed', error);
      process.exitCode = 1;
    }
  });
  server.closeIdleConnections();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('error', (error) => {
  console.error('Server failed to start', error);
  close();
  process.exitCode = 1;
});
