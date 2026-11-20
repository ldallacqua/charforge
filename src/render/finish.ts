// The finishing step: an approved picture enlarged 2x by redrawing it in overlapping tiles and joining
// them without seams. tools/tiles.py cuts the tiles and joins them (no model runs there); the
// character's backend redraws every tile:
//
//   codex, openai  gpt   GPT redraws each enlarged, soft tile sharp, with nothing moved (Siren Siege
//                        D-037, the method the owner compared and chose). SFW only.
//   comfyui        sd    SDXL img2img with the character's checkpoint and LoRA at low denoise, plus a
//                        face tile at higher resolution. The local route, and the only one for NSFW.
//   mock           gpt   tiles come back unchanged: tests the cut and the join without a model.
//
// Why it matters: the sprite the owner sees has the face at 265 px (face detector box); a full-body master
// has it at ~230 px (1152x2016) or ~175 px (GPT's 1024x1536). Cropping without this step enlarges the crop
// and it looks soft; after it, the crop shrinks the master.
//
// Machine settings (env): CHARFORGE_PYTHON, a Python with numpy, pillow and opencv-python-headless<5.
// Found automatically at tools/.venv.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { BACKENDS, render } from './index.ts';
import type { BackendConfig, BackendId, Log, RenderOutput, RenderRequest } from './types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'tools', 'tiles.py');

export type FinishMode = 'gpt' | 'sd';

/** What the GPT image tool is asked for each tile of a cut-out picture (sent on a flat dark colour). */
export const TILE_PROMPT_CUTOUT =
  'This is an enlarged, soft section cut from a larger anime illustration of a character. The flat dark colour around ' +
  'the character is not part of the picture: it is empty background and must come out fully transparent. Redraw this ' +
  'section sharp, in the same framing: keep every shape, line, colour, finger, fingernail, facial feature, ornament ' +
  'and pattern exactly where it is, edge to edge, with nothing moved, added, removed, completed or cropped, no border, ' +
  'no glow and no shadow around the character. Add only the fine detail the softness hides: crisp clean line art and ' +
  'smooth shading, as a high resolution anime illustration with a transparent background.';

/** The same for an opaque picture (a master on its flat background). */
export const TILE_PROMPT_OPAQUE =
  'This is an enlarged, soft section cut from a larger anime illustration. Redraw this section sharp, in the same ' +
  'framing: keep every shape, line, colour, finger, fingernail, facial feature, ornament, pattern and the background ' +
  'exactly where they are, edge to edge, with nothing moved, added, removed, completed or cropped, and no border. Add ' +
  'only the fine detail the softness hides: crisp clean line art and smooth shading, as a high resolution anime illustration.';

export const FINISH_LABEL: Record<FinishMode, string> = {
  gpt: 'GPT em blocos',
  sd: 'GPU local em blocos (SDXL + LoRA)',
};

export function finishMode(backend: BackendId): FinishMode {
  if (backend === 'comfyui') return 'sd';
  if (backend === 'codex' || backend === 'openai' || backend === 'mock') return 'gpt';
  throw new Error(`the ${backend} backend cannot finish pictures (use comfyui, codex or openai)`);
}

export function findPython(): string {
  if (process.env.CHARFORGE_PYTHON) return process.env.CHARFORGE_PYTHON;
  for (const p of [join(ROOT, 'tools', '.venv', 'bin', 'python'), join(ROOT, 'tools', '.venv', 'Scripts', 'python.exe')]) if (existsSync(p)) return p;
  return 'python3';
}

const SETUP = 'python3 -m venv tools/.venv && tools/.venv/bin/pip install numpy pillow "opencv-python-headless<5" (or set CHARFORGE_PYTHON)';

function tiles(args: string[]): Promise<Record<string, unknown>> {
  const python = findPython();
  return new Promise((resolve_, reject) => {
    const p = spawn(python, ['-I', SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`could not run ${python} (${e.message}). The finishing step needs Python: ${SETUP}`)));
    p.on('close', (code) => {
      if (code !== 0) {
        const missing = /No module named '(\w+)'/.exec(err);
        return reject(new Error(missing ? `${python} has no ${missing[1]}: ${SETUP}` : `tools/tiles.py ${args[0]} failed: ${err.trim().split('\n').slice(-3).join(' ')}`));
      }
      const last = out.trim().split('\n').pop() ?? '{}';
      try {
        resolve_(JSON.parse(last));
      } catch {
        reject(new Error(`tools/tiles.py ${args[0]} printed no result: ${last}`));
      }
    });
  });
}

interface Plan {
  mode: FinishMode;
  scale: number;
  alpha: boolean;
  face: [number, number, number, number] | null;
  tiles: { box: [number, number, number, number]; size: [number, number]; face: boolean; denoise: number }[];
}

async function pool(n: number, width: number, work: (i: number) => Promise<void>) {
  let next = 0;
  const lane = async () => {
    while (next < n) await work(next++);
  };
  await Promise.all(Array.from({ length: Math.min(width, n) }, lane));
}

/** Enlarge `req.init` by redrawing it in tiles with the configured backend. Returns one picture. */
export async function finish(config: BackendConfig, req: RenderRequest, outDir: string, log: Log = () => {}): Promise<RenderOutput[]> {
  if (!req.init) throw new Error('finishing needs the picture to enlarge (init)');
  const b = BACKENDS[config.backend];
  if (!b) throw new Error(`unknown backend ${config.backend}`);
  const options = config.options ?? {};
  if (req.rating === 'nsfw' && !b.allowsNsfw(options)) throw new Error(`${b.label} cannot render NSFW`);
  const mode = finishMode(config.backend);
  const spec = req.finish ?? {};
  const work = join(outDir, 'tiles');
  await mkdir(work, { recursive: true });

  const cut = ['cut', req.init, work, '--mode', mode, '--scale', String(spec.scale ?? 2)];
  if (spec.face) {
    const [x0, y0, x1, y1] = spec.face.map(Math.round);
    cut.push('--face', `${x0},${y0},${x1 - x0},${y1 - y0}`);
  }
  if (spec.density) cut.push('--density', String(spec.density));
  if (spec.denoise) cut.push('--denoise', String(spec.denoise));
  if (spec.faceDenoise) cut.push('--face-denoise', String(spec.faceDenoise));
  await tiles(cut);
  const plan = JSON.parse(await readFile(join(work, 'tiles.json'), 'utf8')) as Plan;
  log(`finish: ${plan.tiles.length} tiles by ${FINISH_LABEL[mode]}${plan.face ? '' : ' (no face found: no face tile)'}`);

  // ComfyUI keeps uploads by name: a per-run tag stops two runs from swapping tiles.
  const tag = randomBytes(4).toString('hex');
  const seed = req.seed ?? Math.floor(Math.random() * 2 ** 31);
  const tries = mode === 'gpt' ? 3 : 2;
  const width = config.backend === 'comfyui' || config.backend === 'mock' ? 1 : Number(options.concurrency ?? 3);
  let done = 0;
  const redraw = async (i: number) => {
    const t = plan.tiles[i];
    const sent = join(work, `${tag}-t${i}.png`);
    await copyFile(join(work, `t${i}.png`), sent);
    if (config.backend === 'mock') {
      await copyFile(sent, join(work, `o${i}.png`));
      return;
    }
    const tileReq: RenderRequest =
      mode === 'gpt'
        ? { prompt: plan.alpha ? TILE_PROMPT_CUTOUT : TILE_PROMPT_OPAQUE, rating: req.rating, init: sent, edit: true, transparent: plan.alpha, width: t.size[0], height: t.size[1], count: 1 }
        : { prompt: req.prompt, negative: req.negative, rating: req.rating, init: sent, denoise: t.denoise, width: t.size[0], height: t.size[1], count: 1, seed, options: { ...req.options, hires: false } };
    let last: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const [o] = await render(config, tileReq, join(work, `r${i}-${Date.now()}`), () => {});
        await copyFile(o.file, join(work, `o${i}.png`));
        log(`finish: tile ${++done}/${plan.tiles.length}${t.face ? ' (face)' : ''}`);
        return;
      } catch (e) {
        last = e;
        log(`finish: tile ${i} attempt ${attempt} failed: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    throw last;
  };
  await pool(plan.tiles.length, width, (i) => redraw(i));

  // A redraw that does not line up with what was sent (another picture, or reframed) is left out by
  // the join and drawn again; after two more rounds the finishing fails rather than guess.
  const file = join(outDir, `finished-${mode}-${Date.now()}.png`);
  let joined: { outline?: string; tiles: { tile: number; dropped?: boolean }[] };
  for (let round = 0; ; round++) {
    joined = (await tiles(['join', req.init, work, file])) as typeof joined;
    const dropped = joined.tiles.filter((t) => t.dropped).map((t) => t.tile);
    if (!dropped.length) break;
    if (round >= 2) throw new Error(`tiles ${dropped.join(', ')} never lined up with the picture; nothing was finished`);
    log(`finish: tiles ${dropped.join(', ')} did not line up with the picture; drawing them again`);
    await pool(dropped.length, width, (k) => redraw(dropped[k]));
  }
  const m = await sharp(file).metadata();
  return [{
    file, width: m.width ?? 0, height: m.height ?? 0, seed: mode === 'sd' ? seed : undefined, backend: config.backend,
    meta: { finish: { mode, method: FINISH_LABEL[mode], scale: plan.scale, tiles: plan.tiles.length, face: plan.face, outline: joined.outline, fit: joined.tiles } },
  }];
}

/** What a worker runs for a job: a render, or the finishing of a picture. */
export function perform(config: BackendConfig, req: RenderRequest, outDir: string, log: Log = () => {}): Promise<RenderOutput[]> {
  return req.finish ? finish(config, req, outDir, log) : render(config, req, outDir, log);
}
