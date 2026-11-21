import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { attachments, codexRequest, sessionOf } from '../src/render/codex.ts';
import { findPython, finish, tilePrompt } from '../src/render/finish.ts';
import { DEFAULT_MODEL, pickSize } from '../src/render/openai.ts';
import { configFor, type RenderProfile } from '../src/render/index.ts';
import { localInputs } from '../src/render/inputs.ts';
import { createApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';
import type { BatchDetail, Job } from '../src/shared/types.ts';

const hybrid: RenderProfile = { sfw: { backend: 'codex' }, nsfw: { backend: 'comfyui', options: { loras: [{ name: 'rin_v1.safetensors', weight: 1 }] } } };

/** The finishing step runs tools/tiles.py: these tests need a Python with numpy, pillow and OpenCV 4. */
const python = spawnSync(findPython(), ['-I', '-c', 'import cv2, numpy, PIL; cv2.CascadeClassifier'], { stdio: 'ignore' }).status === 0;

/** A small picture with detail at every scale: stripes, a disc and soft edges. */
async function picture(width: number, height: number, alpha: boolean) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${alpha ? '' : `<rect width="100%" height="100%" fill="#fff"/>`}
    <ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * 0.4}" ry="${height * 0.45}" fill="#d9a78f"/>
    ${Array.from({ length: 12 }, (_, i) => `<rect x="${(i * width) / 12}" y="${height * 0.3}" width="${width / 30}" height="${height * 0.4}" fill="#2a1d33"/>`).join('')}
    <circle cx="${width / 2}" cy="${height * 0.2}" r="${width * 0.12}" fill="#7a2f45"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('finishing requests', () => {
  it('codex edit mode attaches the tile as the input image and asks for transparency', () => {
    const r = codexRequest({ prompt: "Redraw this section sharp, don't move anything", rating: 'sfw', init: '/x/t0.png', edit: true, transparent: true }, ['t0.png']);
    expect(r).toMatch(/attached image \(also at \.\/ref\/t0\.png\) as the input image and with transparent_background set to true/);
    expect(r).toMatch(/Do not write or run any code/);
    expect(r).not.toMatch(/Reference images/);
  });

  it('codex images come from the run\'s own session, found by its working directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cf-codex-'));
    const now = new Date();
    const day = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    await mkdir(day, { recursive: true });
    const ours = '00000000-0000-7000-8000-000000000001';
    const theirs = '00000000-0000-7000-8000-000000000002';
    const meta = (id: string, cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n';
    await writeFile(join(day, `rollout-x-${theirs}.jsonl`), meta(theirs, '/tmp/charforge-codex-other'));
    await writeFile(join(day, `rollout-x-${ours}.jsonl`), meta(ours, '/tmp/charforge-codex-mine'));
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(await sessionOf('/tmp/charforge-codex-mine', Date.now() - 60_000)).toBe(ours);
      expect(await sessionOf('/tmp/charforge-codex-none', Date.now() - 60_000)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    }
  });

  it('the tile prompt names the backdrop the cut picked, and keeps the eyes', () => {
    const p = tilePrompt(true, [230, 230, 230]);
    expect(p).toMatch(/flat light grey \(#e6e6e6\) around the figure is empty background/);
    expect(p).toMatch(/Keep the eyes exactly as drawn/);
    expect(tilePrompt(false, [128, 128, 128])).toMatch(/Keep the background exactly as it is/);
  });

  it('codex attaches every reference, not only the picture to edit', () => {
    expect(attachments({ prompt: 'x', rating: 'sfw', references: ['/a/m.png', '/a/s.png'] }, ['m.png', 's.png'], '/w'))
      .toEqual(['--image', '/w/ref/m.png', '/w/ref/s.png', '--']);
    expect(attachments({ prompt: 'x', rating: 'sfw', init: '/a/t0.png', edit: true }, ['t0.png'], '/w')).toEqual(['--image', '/w/ref/t0.png', '--']);
    expect(attachments({ prompt: 'x', rating: 'sfw' }, [], '/w')).toEqual([]);
    expect(codexRequest({ prompt: 'x', rating: 'sfw' }, ['m.png'])).toMatch(/Reference images \(attached/);
  });

  it('openai uses a live model and asks newer models for the exact shape', () => {
    expect(DEFAULT_MODEL).not.toBe('gpt-image-1');
    expect(pickSize(DEFAULT_MODEL, 1024, 1536)).toBe('1024x1536');
    const [w, h] = pickSize(DEFAULT_MODEL, 2304, 4032).split('x').map(Number);
    expect(w % 16 + h % 16).toBe(0);
    expect(w * h).toBeLessThanOrEqual(2560 * 1440);
    expect(Math.abs(w / h - 2304 / 4032)).toBeLessThan(0.01);
    expect(pickSize('gpt-image-1.5', 900, 1500)).toBe('1024x1536');
  });

  it('another backend can be asked for by name and keeps its options from the profile', () => {
    expect(configFor(hybrid, 'sfw')).toEqual(hybrid.sfw);
    expect(configFor(hybrid, 'sfw', 'comfyui')).toEqual(hybrid.nsfw);
    expect(configFor(hybrid, 'nsfw', 'openai')).toEqual({ backend: 'openai', options: {} });
  });
});

describe.skipIf(!python)('finishing (tools/tiles.py)', () => {
  it('cuts, redraws (mock: unchanged) and joins to twice the size without seams', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-fin-'));
    const src = join(dir, 'p.png');
    await writeFile(src, await picture(800, 1200, true));
    const [out] = await finish({ backend: 'mock' }, { prompt: '', rating: 'sfw', init: src, finish: { face: [340, 160, 460, 280] } }, join(dir, 'out'));
    expect([out.width, out.height]).toEqual([1600, 2400]);
    const meta = out.meta.finish as { tiles: number; outline: string; edgeLoss: number; back: number[] };
    expect(meta.tiles).toBe(4); // three full-width bands (1536x1024 redraws) and the face tile
    expect(meta.outline).toBe("the approved picture's"); // mock tiles are opaque
    expect(meta.edgeLoss).toBe(0);
    expect(meta.back).not.toEqual([46, 40, 56]); // the dark backdrop would sit on the dark stripes
    // every tile has the shape of its redraw: nothing is stretched on the way to GPT
    const plan = JSON.parse(await readFile(join(dir, 'out', 'tiles', 'tiles.json'), 'utf8')) as { tiles: { box: number[]; size: number[] }[] };
    for (const t of plan.tiles) expect(Math.abs((t.box[2] - t.box[0]) / (t.box[3] - t.box[1]) - t.size[0] / t.size[1])).toBeLessThan(0.01);
    // Unchanged tiles must join back into the plain enlargement: any seam would show here.
    const a = await sharp(out.file).removeAlpha().raw().toBuffer();
    const b = await sharp(src).resize(1600, 2400, { kernel: 'lanczos3' }).flatten({ background: '#2e2838' }).raw().toBuffer();
    const alpha = await sharp(out.file).extractChannel(3).raw().toBuffer();
    let diff = 0;
    let n = 0;
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] < 255) continue;
      for (let c = 0; c < 3; c++) diff += Math.abs(a[i * 3 + c] - b[i * 3 + c]);
      n += 3;
    }
    expect(diff / n).toBeLessThan(2.5);
  });

  it('a finish job from an item arrives as a batch with the item as "before" and its regions at 2x', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cf-app-'));
    const db = openDb(':memory:');
    const app = createApp(db, dataDir);
    const ch = db.createCharacter({ slug: 'rin', name: 'Rin', profile: { sfw: { backend: 'mock' }, nsfw: null } });
    const batchId = db.createBatch({ characterId: ch.id, phase: 'g5', kind: 'review', title: 'Sprites', notes: '', parentId: null });
    await mkdir(join(dataDir, 'files', 'rin', String(batchId)), { recursive: true });
    await writeFile(join(dataDir, 'files', 'rin', String(batchId), 'a.png'), await picture(160, 240, false));
    const itemId = db.addItem({
      batchId, position: 0, label: 'joy', group: '', file: `rin/${batchId}/a.png`, thumb: `rin/${batchId}/a.png`, prevFile: null,
      width: 160, height: 240, hasAlpha: false, source: null, meta: {},
      regions: [{ id: 'r1', kind: 'face', label: 'Rosto', box: [50, 20, 110, 80] }], checks: [],
    });
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const job = (await (await post('/api/characters/rin/jobs', { fromItem: itemId, finish: true })).json()) as Job;
    expect(job).toMatchObject({ backend: 'mock', rating: 'sfw', title: 'Ampliação 2× de joy' });
    expect(job.request.finish).toMatchObject({ scale: 2, face: [50, 20, 110, 80], sourceItem: itemId });

    // what `forge worker` does
    const claimed = (await (await post('/api/jobs/claim', { backends: ['mock'], worker: 't' })).json()) as { job: Job; config: { backend: 'mock' } };
    const work = await mkdtemp(join(tmpdir(), 'cf-w-'));
    const req = await localInputs(claimed.job.request, dataDir, work);
    const [o] = await finish(claimed.config, req, work);
    const fd = new FormData();
    fd.append('o0', new Blob([await readFile(o.file)]), 'out.png');
    fd.append('previous', new Blob([await readFile(req.init!)]), 'before.png');
    fd.append('outputs', JSON.stringify([{ field: 'o0', previous: 'previous', meta: o.meta }]));
    const batch = (await (await app.request(`/api/jobs/${job.id}/complete`, { method: 'POST', body: fd })).json()) as { id: number };
    const detail = (await (await app.request(`/api/batches/${batch.id}`)).json()) as BatchDetail;
    const item = detail.items[0];
    expect([item.width, item.height]).toEqual([320, 480]);
    expect(item.prevUrl).toBeTruthy();
    expect(item.regions[0].box).toEqual([100, 40, 220, 160]);
    expect(item.label).toBe('GPT em blocos');
  });
});

describe('finishing never sends an unrated or NSFW image to the cloud', () => {
  it('an image with no rating counts as NSFW when the character has NSFW, and a cloud backend is refused', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, await mkdtemp(join(tmpdir(), 'cf-app-')));
    const ch = db.createCharacter({ slug: 'rin', name: 'Rin', profile: hybrid });
    const batchId = db.createBatch({ characterId: ch.id, phase: 'g5', kind: 'review', title: 'Sprites', notes: '', parentId: null });
    const itemId = db.addItem({ batchId, position: 0, label: 'joy', group: '', file: 'rin/1/a.png', thumb: 'rin/1/a.png', prevFile: null, width: 10, height: 10, hasAlpha: true, source: null, meta: {}, regions: [], checks: [] });
    const post = (body: unknown) => app.request('/api/characters/rin/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const local = await post({ fromItem: itemId, finish: true });
    expect(await local.json()).toMatchObject({ backend: 'comfyui', rating: 'nsfw' });
    const refused = await post({ fromItem: itemId, finish: true, backend: 'codex' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/cannot render NSFW/);
    const sfw = await post({ fromItem: itemId, finish: true, backend: 'codex', rating: 'sfw' });
    expect(await sfw.json()).toMatchObject({ backend: 'codex', rating: 'sfw' });
  });
});
