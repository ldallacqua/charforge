// HTTP API (Hono). The web app and the agent CLI both talk to this.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { Db } from './db.ts';
import { storeImage, safeName } from './store.ts';
import { exportVerdicts, submitBlockers } from './verdicts.ts';
import { phaseOf } from '../shared/phases.ts';
import { reasonOf } from '../shared/taxonomy.ts';
import type { BatchKind, Box, GateMark, Job, Manifest, Pin, Region, Review, ServerEvent } from '../shared/types.ts';
import { BACKENDS, PRESETS, configFor, validateProfile, type BackendId, type FinishSpec, type Rating, type RenderProfile, type RenderRequest } from '../render/index.ts';
import { FINISH_LABEL, finishMode, perform } from '../render/finish.ts';
import { localInputs } from '../render/inputs.ts';
import { nextStep } from './next.ts';

type Listener = (e: ServerEvent) => void;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp(db: Db, dataDir: string, webDir?: string) {
  const app = new Hono();
  const listeners = new Set<Listener>();
  const emit = (e: ServerEvent) => listeners.forEach((l) => l(e));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---------- characters ----------

  app.get('/api/characters', (c) => c.json({ characters: db.listCharacters(), waiting: db.openBatches() }));

  app.post('/api/characters', async (c) => {
    const body = await c.req.json<{ slug?: string; name?: string; summary?: string; brief?: string; preset?: string; profile?: RenderProfile; adult?: boolean }>();
    const slug = (body.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) return c.json({ error: 'slug: letras minúsculas, números e hífens' }, 400);
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
    if (db.characterRow(slug)) return c.json({ error: `character ${slug} already exists` }, 409);
    const profile = body.profile ?? (body.preset ? PRESETS.find((p) => p.id === body.preset)?.profile : undefined) ?? null;
    if (body.preset && !profile) return c.json({ error: `unknown preset ${body.preset}` }, 400);
    if (profile) {
      const err = validateProfile(profile);
      if (err) return c.json({ error: err }, 400);
    }
    const gates: Record<string, GateMark> = {};
    if (body.adult && profile) gates.g0 = { status: 'done', at: new Date().toISOString(), by: 'owner', note: 'Adulto confirmado e perfil de geração escolhido na criação.' };
    const ch = db.createCharacter({ slug, name: body.name.trim(), summary: body.summary, brief: body.brief, profile, gates });
    emit({ type: 'character.updated', slug });
    return c.json(ch, 201);
  });

  app.get('/api/characters/:slug', (c) => {
    const ch = db.getCharacter(c.req.param('slug'));
    return ch ? c.json(ch) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/api/characters/:slug', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json<{ name?: string; summary?: string; brief?: string; coverItemId?: number; profile?: RenderProfile | null; preset?: string }>();
    let profile = body.profile;
    if (body.preset) {
      profile = PRESETS.find((p) => p.id === body.preset)?.profile;
      if (!profile) return c.json({ error: `unknown preset ${body.preset}` }, 400);
    }
    if (profile) {
      const err = validateProfile(profile);
      if (err) return c.json({ error: err }, 400);
    }
    let cover: string | undefined;
    if (body.coverItemId) {
      const it = db.itemRow(body.coverItemId);
      if (!it) return c.json({ error: 'item not found' }, 404);
      cover = it.file as string;
    }
    const ch = db.updateCharacter(slug, { name: body.name, summary: body.summary, brief: body.brief, cover, profile });
    if (!ch) return c.json({ error: 'not found' }, 404);
    emit({ type: 'character.updated', slug });
    return c.json(ch);
  });

  app.post('/api/characters/:slug/gates/:gate', async (c) => {
    const slug = c.req.param('slug');
    const gate = c.req.param('gate');
    if (!phaseOf(gate)) return c.json({ error: `unknown gate ${gate}` }, 400);
    const body = await c.req.json<{ status?: 'done' | 'open'; note?: string; by?: 'owner' | 'agent' }>().catch(() => ({}) as { status?: 'done' | 'open'; note?: string; by?: 'owner' | 'agent' });
    const gates = db.setGate(slug, gate, body.status === 'open' ? null : { status: 'done', at: new Date().toISOString(), by: body.by ?? 'owner', note: body.note });
    if (!gates) return c.json({ error: 'not found' }, 404);
    emit({ type: 'character.updated', slug });
    return c.json(gates);
  });

  app.get('/api/characters/:slug/next', (c) => {
    const ch = db.getCharacter(c.req.param('slug'));
    if (!ch) return c.json({ error: 'not found' }, 404);
    return c.json(nextStep(ch, db.listJobs({ slug: ch.slug, active: true })));
  });

  app.get('/api/presets', (c) =>
    c.json({
      presets: PRESETS,
      backends: Object.values(BACKENDS).map((b) => ({ id: b.id, label: b.label, nsfw: b.allowsNsfw({}), unavailableHere: b.unavailable({}) })),
      worker: workerBackends,
    }),
  );

  // ---------- render jobs ----------

  app.get('/api/jobs', (c) => c.json(db.listJobs({ slug: c.req.query('character'), active: c.req.query('active') === '1' })));

  app.post('/api/characters/:slug/jobs', async (c) => {
    const slug = c.req.param('slug');
    const ch = db.getCharacter(slug);
    if (!ch) return c.json({ error: 'not found' }, 404);
    if (!ch.profile) return c.json({ error: 'this character has no render profile yet' }, 409);
    const body = await c.req.json<{
      phase?: string; kind?: BatchKind; title?: string; group?: string; request?: RenderRequest; fromItem?: number; count?: number;
      /** finish the item (enlarge 2x in tiles) instead of repeating its render */
      finish?: boolean | FinishSpec;
      /** a backend other than the profile's for this rating, to compare methods */
      backend?: BackendId;
      rating?: Rating;
    }>();
    let request = body.request;
    let phase = body.phase;
    let title = body.title ?? '';
    if (body.fromItem && body.finish) {
      const it = db.itemRow(body.fromItem);
      if (!it) return c.json({ error: 'item not found' }, 404);
      const meta = JSON.parse(it.meta as string) as { request?: RenderRequest; rating?: Rating };
      const regions = JSON.parse(it.regions as string) as Region[];
      // An image whose rating the studio does not know is treated as NSFW, so it never leaves the machine.
      const rating: Rating = body.rating ?? meta.rating ?? meta.request?.rating ?? (ch.profile.nsfw ? 'nsfw' : 'sfw');
      const spec: FinishSpec = typeof body.finish === 'object' ? body.finish : {};
      request = {
        prompt: meta.request?.prompt ?? '', negative: meta.request?.negative, rating, init: `/files/${it.file as string}`, count: 1,
        options: meta.request?.options,
        finish: { scale: 2, ...spec, face: spec.face ?? regions.find((g) => g.kind === 'face')?.box ?? null, regions, sourceItem: it.id as number },
      };
      phase ??= db.batchSummary(it.batch_id as number)?.phase;
      title ||= `Ampliação 2× de ${it.label as string}`;
    } else if (body.fromItem) {
      // "more like this": same request as the item that came from a render, new seeds
      const it = db.itemRow(body.fromItem);
      const meta = it ? (JSON.parse(it.meta as string) as { request?: RenderRequest }) : null;
      if (!it || !meta?.request) return c.json({ error: 'this image has no render request to repeat' }, 400);
      request = { ...meta.request, seed: undefined, count: body.count ?? 4 };
      phase ??= db.batchSummary(it.batch_id as number)?.phase;
      title ||= `Variações de ${it.label}`;
    }
    if (!request) return c.json({ error: 'request (or fromItem) is required' }, 400);
    if (!request.finish && !request.prompt?.trim()) return c.json({ error: 'request.prompt is required' }, 400);
    if (request.finish && !request.init) return c.json({ error: 'finishing needs request.init (the picture)' }, 400);
    if (!phase || !phaseOf(phase)) return c.json({ error: 'phase is required (g0..g8)' }, 400);
    const rating = request.rating === 'nsfw' ? 'nsfw' : 'sfw';
    let config;
    try {
      config = configFor(ch.profile, rating, body.backend);
      if (rating === 'nsfw' && !BACKENDS[config.backend].allowsNsfw(config.options ?? {})) throw new Error(`${BACKENDS[config.backend].label} cannot render NSFW: NSFW stays on a local backend`);
      if (request.finish) finishMode(config.backend);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
    const job = db.createJob({ characterId: ch.id, phase, kind: body.kind ?? 'review', rating, backend: config.backend, title: title || `Geração ${phase.toUpperCase()}`, group: body.group ?? '', request: { ...request, rating } });
    emit({ type: 'job.updated', job });
    kickWorker();
    return c.json(job, 201);
  });

  /** Workers (forge worker, or this server) take jobs for the backends they can run. */
  app.post('/api/jobs/claim', async (c) => {
    const body = await c.req.json<{ backends?: string[]; worker?: string }>();
    const job = db.claimJob(body.backends ?? [], body.worker ?? 'worker');
    if (!job) return c.body(null, 204);
    emit({ type: 'job.updated', job });
    const ch = db.getCharacter(job.characterSlug)!;
    return c.json({ job, config: ch.profile ? configFor(ch.profile, job.rating, job.backend as BackendId) : null });
  });

  app.post('/api/jobs/:id/complete', async (c) => {
    const id = Number(c.req.param('id'));
    const job = db.getJob(id);
    if (!job) return c.json({ error: 'not found' }, 404);
    const form = await c.req.parseBody({ all: false });
    const outputs = JSON.parse(String(form.outputs ?? '[]')) as JobOutput[];
    const batch = await completeJob(job, outputs, formFile(form));
    return c.json(batch);
  });

  /** A job's result as a worker reports it: file fields, plus the picture it started from when finishing. */
  type JobOutput = { field: string; previous?: string; seed?: number; meta?: Record<string, unknown> };

  app.post('/api/jobs/:id/fail', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.json<{ error?: string }>().catch(() => ({ error: '' }));
    db.finishJob(id, { error: body.error || 'failed' });
    const job = db.getJob(id);
    if (job) emit({ type: 'job.updated', job });
    return c.json(job);
  });

  async function completeJob(job: Job, outputs: JobOutput[], getFile: (f: string) => Promise<Upload | null>) {
    if (!outputs.length) throw new HttpError(400, 'no outputs');
    const req = job.request;
    const fin = req.finish;
    const method = fin ? FINISH_LABEL[finishMode(job.backend as BackendId)] : '';
    const scale = fin?.scale ?? 2;
    const batch = await ingest(
      {
        character: job.characterSlug, phase: job.phase, kind: job.kind, title: job.title,
        notes: fin
          ? `Ampliado ${scale}× por ${method} (${job.backend}, job #${job.id}). Compare com a imagem de antes (tecla C) a 3×: olhos, mãos, contorno, cor da pele.`
          : `Gerado por ${job.backend} (job #${job.id}). Prompt: ${req.prompt.slice(0, 400)}`,
        items: outputs.map((o, i) => ({
          file: o.field, previous: o.previous, group: job.group,
          label: fin ? method : o.seed !== undefined ? `seed ${o.seed}` : `${job.backend} ${i + 1}`,
          regions: fin?.regions?.map((g) => ({ id: g.id, kind: g.kind as Region['kind'], label: g.label, box: g.box.map((v) => Math.round(v * scale)) as Box })),
          meta: { ...o.meta, backend: job.backend, rating: job.rating, seed: o.seed, jobId: job.id, request: { ...req, seed: o.seed, count: 1 } },
        })),
      },
      getFile,
    );
    db.finishJob(job.id, { batchId: batch.id });
    emit({ type: 'job.updated', job: db.getJob(job.id)! });
    return batch;
  }

  // In-process worker for the backends this server can run itself (CHARFORGE_WORKER_BACKENDS).
  const workerBackends = (process.env.CHARFORGE_WORKER_BACKENDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const workerName = `server@${hostname()}`;
  db.requeueStale(workerName);
  let working = false;
  async function kickWorker() {
    if (working || !workerBackends.length) return;
    working = true;
    try {
      for (let job = db.claimJob(workerBackends, workerName); job; job = db.claimJob(workerBackends, workerName)) {
        emit({ type: 'job.updated', job });
        const ch = db.getCharacter(job.characterSlug)!;
        const dir = await mkdtemp(join(tmpdir(), 'charforge-job-'));
        try {
          const req = await localInputs(job.request, dataDir, dir);
          const outs = await perform(configFor(ch.profile!, job.rating, job.backend as BackendId), req, dir, (l) => console.log(`[job ${job!.id}] ${l}`));
          const files = new Map<string, Upload>();
          if (req.finish && req.init) files.set('previous', { name: basename(req.init), data: new Uint8Array(await readFile(req.init)) });
          const list: JobOutput[] = await Promise.all(outs.map(async (o, i) => {
            files.set(`o${i}`, { name: basename(o.file), data: new Uint8Array(await readFile(o.file)) });
            return { field: `o${i}`, previous: files.has('previous') ? 'previous' : undefined, seed: o.seed, meta: o.meta };
          }));
          await completeJob(job, list, async (f) => files.get(f) ?? null);
        } catch (e) {
          db.finishJob(job.id, { error: (e as Error).message });
          emit({ type: 'job.updated', job: db.getJob(job.id)! });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    } finally {
      working = false;
    }
  }
  if (workerBackends.length) setInterval(kickWorker, 5000).unref();

  // ---------- batches ----------

  type Upload = { name: string; data: Uint8Array };

  /** Store a batch from a manifest; file fields resolve through getFile. Returns the batch or throws. */
  async function ingest(m: Manifest, getFile: (field: string) => Promise<Upload | null>) {
    const ch = db.characterRow(m.character);
    if (!ch) throw new HttpError(404, `character ${m.character} not found (forge char add ${m.character} --name ...)`);
    if (!phaseOf(m.phase)) throw new HttpError(400, `unknown phase ${m.phase} (g0..g8)`);
    if (!m.title?.trim()) throw new HttpError(400, 'title is required');
    if (!Array.isArray(m.items) || !m.items.length) throw new HttpError(400, 'items is empty');
    const kind = m.kind ?? 'review';
    if (kind !== 'review' && kind !== 'pick') throw new HttpError(400, 'kind must be review or pick');

    const batchId = db.createBatch({ characterId: ch.id, phase: m.phase, kind, title: m.title.trim(), notes: m.notes ?? '', parentId: m.parentId ?? null });
    const rel = `${safeName(ch.slug)}/${batchId}`;
    try {
      const prepared: Parameters<Db['addItem']>[0][] = [];
      for (const [i, it] of m.items.entries()) {
        const f = await getFile(it.file);
        if (!f) throw new Error(`item ${i}: file field ${it.file} missing`);
        const label = it.label?.trim() || f.name.replace(/\.[^.]+$/, '');
        const pos = String(i + 1).padStart(3, '0');
        const stored = await storeImage(dataDir, rel, `${pos}-${f.name}`, f.data);
        let prevFile: string | null = null;
        if (it.previous) {
          const p = await getFile(it.previous);
          if (!p) throw new Error(`item ${i}: previous field ${it.previous} missing`);
          prevFile = (await storeImage(dataDir, `${rel}/prev`, `${pos}-${p.name}`, p.data)).file;
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
      throw new HttpError(400, (e as Error).message);
    }
    if (!ch.cover) {
      const first = db.raw.prepare('SELECT file FROM items WHERE batch_id = ? ORDER BY position LIMIT 1').get(batchId) as { file: string };
      db.updateCharacter(ch.slug, { cover: first.file });
    }
    const batch = db.batchSummary(batchId)!;
    emit({ type: 'batch.created', batch });
    return batch;
  }

  const formFile = (form: Record<string, unknown>) => async (field: string): Promise<Upload | null> => {
    const f = form[field];
    return f instanceof File ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) } : null;
  };

  app.post('/api/batches', async (c) => {
    const form = await c.req.parseBody({ all: false });
    if (typeof form.manifest !== 'string') return c.json({ error: 'manifest field (JSON) is required' }, 400);
    return c.json(await ingest(JSON.parse(form.manifest) as Manifest, formFile(form)), 201);
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
