// HTTP API (Hono). The web app and the agent CLI both talk to this.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Db } from './db.ts';
import { storeImage, safeName } from './store.ts';
import { exportVerdicts, submitBlockers } from './verdicts.ts';
import { phaseOf } from '../shared/phases.ts';
import { reasonOf } from '../shared/taxonomy.ts';
import type { Box, Manifest, Pin, Region, Review, ServerEvent } from '../shared/types.ts';

type Listener = (e: ServerEvent) => void;

export function createApp(db: Db, dataDir: string, webDir?: string) {
  const app = new Hono();
  const listeners = new Set<Listener>();
  const emit = (e: ServerEvent) => listeners.forEach((l) => l(e));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---------- characters ----------

  app.get('/api/characters', (c) => c.json({ characters: db.listCharacters(), waiting: db.openBatches() }));

  app.post('/api/characters', async (c) => {
    const body = await c.req.json<{ slug?: string; name?: string; summary?: string }>();
    const slug = (body.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) return c.json({ error: 'slug: letras minúsculas, números e hífens' }, 400);
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
    if (db.characterRow(slug)) return c.json({ error: `character ${slug} already exists` }, 409);
    const ch = db.createCharacter({ slug, name: body.name.trim(), summary: body.summary });
    emit({ type: 'character.updated', slug });
    return c.json(ch, 201);
  });

  app.get('/api/characters/:slug', (c) => {
    const ch = db.getCharacter(c.req.param('slug'));
    return ch ? c.json(ch) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/api/characters/:slug', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json<{ name?: string; summary?: string; coverItemId?: number }>();
    let cover: string | undefined;
    if (body.coverItemId) {
      const it = db.itemRow(body.coverItemId);
      if (!it) return c.json({ error: 'item not found' }, 404);
      cover = it.file as string;
    }
    const ch = db.updateCharacter(slug, { name: body.name, summary: body.summary, cover });
    if (!ch) return c.json({ error: 'not found' }, 404);
    emit({ type: 'character.updated', slug });
    return c.json(ch);
  });

  // ---------- batches ----------

  app.post('/api/batches', async (c) => {
    const form = await c.req.parseBody({ all: false });
    const raw = form.manifest;
    if (typeof raw !== 'string') return c.json({ error: 'manifest field (JSON) is required' }, 400);
    const m = JSON.parse(raw) as Manifest;
    const ch = db.characterRow(m.character);
    if (!ch) return c.json({ error: `character ${m.character} not found (forge char add ${m.character} --name ...)` }, 404);
    if (!phaseOf(m.phase)) return c.json({ error: `unknown phase ${m.phase} (g0..g8)` }, 400);
    if (!m.title?.trim()) return c.json({ error: 'title is required' }, 400);
    if (!Array.isArray(m.items) || !m.items.length) return c.json({ error: 'items is empty' }, 400);
    const kind = m.kind ?? 'review';
    if (kind !== 'review' && kind !== 'pick') return c.json({ error: 'kind must be review or pick' }, 400);

    // store every file first, so a bad upload does not leave a half-created batch
    const batchId = db.createBatch({ characterId: ch.id, phase: m.phase, kind, title: m.title.trim(), notes: m.notes ?? '', parentId: m.parentId ?? null });
    const rel = `${safeName(ch.slug)}/${batchId}`;
    try {
      const prepared: Parameters<Db['addItem']>[0][] = [];
      for (const [i, it] of m.items.entries()) {
        const f = form[it.file];
        if (!(f instanceof File)) throw new Error(`item ${i}: file field ${it.file} missing`);
        const label = it.label?.trim() || f.name.replace(/\.[^.]+$/, '');
        const pos = String(i + 1).padStart(3, '0');
        const stored = await storeImage(dataDir, rel, `${pos}-${f.name}`, new Uint8Array(await f.arrayBuffer()));
        let prevFile: string | null = null;
        if (it.previous) {
          const p = form[it.previous];
          if (!(p instanceof File)) throw new Error(`item ${i}: previous field ${it.previous} missing`);
          prevFile = (await storeImage(dataDir, `${rel}/prev`, `${pos}-${p.name}`, new Uint8Array(await p.arrayBuffer()))).file;
        }
        const regions: Region[] = (it.regions ?? []).map((g, j) => ({
          id: g.id ?? `r${j + 1}`, kind: g.kind, label: g.label || g.kind,
          box: clampBox(g.box, stored.width, stored.height),
        }));
        prepared.push({ batchId, position: i, label, group: it.group ?? '', file: stored.file, thumb: stored.thumb, prevFile,
          width: stored.width, height: stored.height, hasAlpha: stored.hasAlpha, source: it.source ?? null, meta: it.meta ?? {},
          regions, checks: it.checks ?? [] });
      }
      db.tx(() => prepared.forEach((p) => db.addItem(p)));
    } catch (e) {
      db.raw.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
      return c.json({ error: (e as Error).message }, 400);
    }
    if (!ch.cover) {
      const first = db.raw.prepare('SELECT file FROM items WHERE batch_id = ? ORDER BY position LIMIT 1').get(batchId) as { file: string };
      db.updateCharacter(ch.slug, { cover: first.file });
    }
    const batch = db.batchSummary(batchId)!;
    emit({ type: 'batch.created', batch });
    return c.json(batch, 201);
  });

  app.get('/api/batches/:id', (c) => {
    const b = db.getBatch(Number(c.req.param('id')));
    return b ? c.json(b) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/batches/:id/verdicts', (c) => {
    const b = db.getBatch(Number(c.req.param('id')));
    return b ? c.json(exportVerdicts(b)) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/batches/:id/submit', async (c) => {
    const id = Number(c.req.param('id'));
    const b = db.getBatch(id);
    if (!b) return c.json({ error: 'not found' }, 404);
    if (b.status === 'submitted') return c.json({ error: 'already submitted' }, 409);
    const blockers = submitBlockers(b);
    if (blockers.length) return c.json({ error: `faltam: ${blockers.join(', ')}`, blockers }, 409);
    const body = await c.req.json<{ note?: string }>().catch(() => ({ note: '' }));
    db.setBatchStatus(id, 'submitted', body.note ?? '');
    const batch = db.batchSummary(id)!;
    emit({ type: 'batch.updated', batch });
    return c.json(batch);
  });

  app.post('/api/batches/:id/reopen', (c) => {
    const id = Number(c.req.param('id'));
    if (!db.batchSummary(id)) return c.json({ error: 'not found' }, 404);
    db.setBatchStatus(id, 'open');
    const batch = db.batchSummary(id)!;
    emit({ type: 'batch.updated', batch });
    return c.json(batch);
  });

  // ---------- reviews ----------

  app.put('/api/items/:id/review', async (c) => {
    const id = Number(c.req.param('id'));
    const row = db.itemRow(id);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'open') return c.json({ error: 'batch already submitted: reopen it to change verdicts' }, 409);
    const patch = await c.req.json<Partial<Review>>();
    const cur = db.getReview(id);
    const next: Review = {
      verdict: patch.verdict !== undefined ? patch.verdict : cur.verdict,
      reasons: patch.reasons ?? cur.reasons,
      regions: patch.regions ?? cur.regions,
      pins: patch.pins ?? cur.pins,
      note: patch.note ?? cur.note,
      updatedAt: null,
    };
    const err = validateReview(next, row.width as number, row.height as number);
    if (err) return c.json({ error: err }, 400);
    db.saveReview(id, next);
    const batchId = row.batch_id as number;
    if (row.kind === 'pick' && next.verdict === 'approve') {
      for (const other of db.clearOtherPicks(id)) emit({ type: 'review.updated', itemId: other, batchId, review: db.getReview(other) });
    }
    const review = db.getReview(id);
    emit({ type: 'review.updated', itemId: id, batchId, review });
    return c.json(review);
  });

  // ---------- live updates ----------

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const send: Listener = (e) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      listeners.add(send);
      stream.onAbort(() => {
        listeners.delete(send);
      });
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '{}' });
        await stream.sleep(25_000);
      }
      listeners.delete(send);
    }),
  );

  // ---------- files and the web app ----------

  const filesRoot = join(dataDir, 'files');
  app.use('/files/*', serveStatic({
    root: relative(process.cwd(), filesRoot) || '.',
    rewriteRequestPath: (p) => decodeURIComponent(p.replace(/^\/files/, '')),
    onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable'),
  }));

  if (webDir && existsSync(webDir)) {
    const rel = relative(process.cwd(), webDir) || '.';
    app.use('/assets/*', serveStatic({ root: rel }));
    app.use('/favicon.svg', serveStatic({ root: rel }));
    const index = join(webDir, 'index.html');
    app.get('*', async (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.html(await readFile(index, 'utf8'))));
  }

  return app;
}

function clampBox(b: Box, w: number, h: number): Box {
  if (!Array.isArray(b) || b.length !== 4 || b.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('region box must be [x0, y0, x1, y1]');
  const [x0, y0, x1, y1] = b;
  return [Math.max(0, Math.min(x0, x1)), Math.max(0, Math.min(y0, y1)), Math.min(w, Math.max(x0, x1)), Math.min(h, Math.max(y0, y1))];
}

function validateReview(r: Review, w: number, h: number): string | null {
  if (r.verdict !== null && r.verdict !== 'approve' && r.verdict !== 'reject') return 'verdict must be approve, reject or null';
  const known = (code: string) => !!reasonOf(code);
  if (!Array.isArray(r.reasons) || !r.reasons.every(known)) return 'unknown reason code';
  for (const m of Object.values(r.regions ?? {})) {
    if (m.verdict !== 'ok' && m.verdict !== 'bad') return 'region verdict must be ok or bad';
    if (!m.reasons.every(known)) return 'unknown reason code in a region';
  }
  for (const p of r.pins as Pin[]) {
    if (!p.id || !Array.isArray(p.box) || p.box.length !== 4) return 'pin needs an id and a box';
    if (p.reason && !known(p.reason)) return 'unknown pin reason';
    p.box = clampBox(p.box, w, h);
  }
  if (typeof r.note !== 'string' || r.note.length > 4000) return 'note must be text (4000 chars max)';
  return null;
}
