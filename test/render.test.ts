import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexRequest } from '../src/render/codex.ts';
import { buildGraph } from '../src/render/comfyui.ts';
import { PRESETS, render, validateProfile } from '../src/render/index.ts';
import { openDb } from '../src/server/db.ts';
import { nextStep } from '../src/server/next.ts';

describe('profiles', () => {
  it('accepts every preset and refuses NSFW on cloud backends', () => {
    for (const p of PRESETS) expect(validateProfile(p.profile)).toBeNull();
    expect(validateProfile({ sfw: { backend: 'comfyui' }, nsfw: { backend: 'openai' } })).toMatch(/cannot render NSFW/);
    expect(validateProfile({ sfw: { backend: 'comfyui' }, nsfw: { backend: 'codex' } })).toMatch(/cannot render NSFW/);
    expect(validateProfile({ sfw: { backend: 'codex' }, nsfw: { backend: 'command', options: { command: ['x'], nsfw: true } } })).toBeNull();
  });

  it('refuses an NSFW request on a cloud backend even if asked directly', async () => {
    await expect(render({ backend: 'codex' }, { prompt: 'x', rating: 'nsfw' }, tmpdir())).rejects.toThrow(/cannot render NSFW/);
  });
});

describe('backends', () => {
  it('mock renders the requested count and size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-'));
    const out = await render({ backend: 'mock' }, { prompt: 'x', rating: 'sfw', count: 2, width: 64, height: 96, seed: 7 }, dir);
    expect(out.map((o) => o.seed)).toEqual([7, 8]);
    expect((await sharp(out[0].file).metadata()).height).toBe(96);
  });

  it('comfyui graph: LoRA chain, clip skip, hires pass, img2img skips hires', () => {
    const o = {
      checkpoint: 'c.safetensors', quality: 'q', negativeBase: 'n', steps: 28, cfg: 6, sampler: 'euler', scheduler: 'normal',
      clipSkip: 2, hires: { scale: 1.5, denoise: 0.4, steps: 20 }, timeoutSec: 1, url: 'x', loras: [{ name: 'a.safetensors', weight: 0.8 }],
    } as Parameters<typeof buildGraph>[0];
    const g = Object.values(buildGraph(o, { prompt: 'p', negative: 'm', rating: 'sfw', width: 768, height: 1344 }, 5));
    const types = g.map((n) => n.class_type);
    expect(types.filter((t) => t === 'KSampler')).toHaveLength(2);
    expect(g.find((n) => n.class_type === 'LoraLoader')?.inputs.strength_model).toBe(0.8);
    expect(g.find((n) => n.class_type === 'CLIPSetLastLayer')?.inputs.stop_at_clip_layer).toBe(-2);
    expect(g.find((n) => n.class_type === 'EmptyLatentImage')?.inputs).toMatchObject({ width: 768, height: 1344 });
    const i2i = Object.values(buildGraph(o, { prompt: 'p', rating: 'sfw', denoise: 0.55 }, 5, 'up.png'));
    expect(i2i.filter((n) => n.class_type === 'KSampler')).toHaveLength(1);
    expect(i2i.find((n) => n.class_type === 'KSampler')?.inputs.denoise).toBe(0.55);
  });

  it('codex request asks for one image, the size and the references', () => {
    const r = codexRequest({ prompt: 'a witch', rating: 'sfw', width: 1024, height: 1536, transparent: true, negative: 'text' }, ['m.png']);
    expect(r).toMatch(/exactly ONE image/);
    expect(r).toMatch(/portrait 2:3/);
    expect(r).toMatch(/transparent/);
    expect(r).toMatch(/\.\/ref\/m\.png/);
    expect(r).toMatch(/Avoid: text/);
  });

  describe('openai against a fake API', () => {
    let server: ReturnType<typeof createServer>;
    let seen: { url?: string; body?: Record<string, unknown> } = {};
    beforeAll(async () => {
      const png = await sharp({ create: { width: 8, height: 12, channels: 4, background: '#f00' } }).png().toBuffer();
      server = createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', () => {
          seen = { url: req.url, body: JSON.parse(raw) };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
      process.env.OPENAI_API_KEY = 'test-key';
    });
    afterAll(() => {
      server.close();
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
    });

    it('maps aspect ratio to a size and asks for transparency', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cf-'));
      const out = await render({ backend: 'openai' }, { prompt: 'a witch', rating: 'sfw', width: 768, height: 1344, transparent: true }, dir);
      expect(seen.url).toBe('/v1/images/generations');
      expect(seen.body).toMatchObject({ size: '1024x1536', background: 'transparent', n: 1 });
      expect(out[0]).toMatchObject({ width: 8, height: 12, backend: 'openai' });
    });
  });
});

describe('next step', () => {
  function character() {
    const db = openDb(':memory:');
    db.createCharacter({ slug: 'lyra', name: 'Lyra', brief: 'Uma bruxa adulta da floresta, cabelo prateado.', profile: { sfw: { backend: 'comfyui' }, nsfw: { backend: 'comfyui' } }, gates: { g0: { status: 'done', at: '', by: 'owner' } } });
    return db;
  }

  it('asks for the brief and the profile first', () => {
    const db = openDb(':memory:');
    db.createCharacter({ slug: 'x', name: 'X' });
    expect(nextStep(db.getCharacter('x')!, []).owner).toMatch(/brief/);
  });

  it('goes gate by gate, then prioritises the owner and the fixes', () => {
    const db = character();
    expect(nextStep(db.getCharacter('lyra')!, []).gate).toBe('g1');
    db.setGate('lyra', 'g1', { status: 'done', at: '', by: 'agent' });
    const start = nextStep(db.getCharacter('lyra')!, []);
    expect(start).toMatchObject({ gate: 'g2', state: 'start' });
    expect(start.agent).toMatch(/Discovery round 1/);

    const ch = db.getCharacter('lyra')!;
    const b = db.createBatch({ characterId: ch.id, phase: 'g2', kind: 'review', title: 'Conceitos', notes: '', parentId: null });
    const item = db.addItem({ batchId: b, position: 0, label: 'a', group: '', file: 'f', thumb: 't', prevFile: null, width: 10, height: 10, hasAlpha: false, source: null, meta: {}, regions: [], checks: [] });
    expect(nextStep(db.getCharacter('lyra')!, [])).toMatchObject({ state: 'owner', batchId: b });

    db.saveReview(item, { verdict: 'reject', reasons: ['concept.generic'], regions: {}, pins: [], note: '', updatedAt: null });
    db.setBatchStatus(b, 'submitted');
    expect(nextStep(db.getCharacter('lyra')!, [])).toMatchObject({ state: 'fix', batchId: b });

    const b2 = db.createBatch({ characterId: ch.id, phase: 'g2', kind: 'review', title: 'Conceitos 2', notes: '', parentId: b });
    const i2 = db.addItem({ batchId: b2, position: 0, label: 'b', group: '', file: 'f', thumb: 't', prevFile: null, width: 10, height: 10, hasAlpha: false, source: null, meta: {}, regions: [], checks: [] });
    db.saveReview(i2, { verdict: 'approve', reasons: ['like.hair'], regions: {}, pins: [], note: '', updatedAt: null });
    db.setBatchStatus(b2, 'submitted');
    expect(nextStep(db.getCharacter('lyra')!, [])).toMatchObject({ gate: 'g2', state: 'signoff' });
  });
});
