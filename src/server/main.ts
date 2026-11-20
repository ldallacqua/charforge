// Starts the studio: API + web app + image files, on one port.
//   PORT (8787), HOST (127.0.0.1), CHARFORGE_DATA (./data)

import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from './db.ts';
import { createApp } from './app.ts';

const root = resolve(import.meta.dirname, '../..');
const dataDir = resolve(process.env.CHARFORGE_DATA ?? join(root, 'data'));
mkdirSync(join(dataDir, 'files'), { recursive: true });

const db = openDb(join(dataDir, 'charforge.db'));
const app = createApp(db, dataDir, join(root, 'dist/web'));
const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`charforge studio on http://${hostname}:${info.port}  (data: ${dataDir})`);
});
