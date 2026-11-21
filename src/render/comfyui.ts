// Local GPU through ComfyUI's HTTP API. SFW and NSFW. Default graph: SDXL/Illustrious checkpoint,
// optional LoRAs, clip skip, a base pass and a hires pass (upscale 1.5x + 20 steps at denoise 0.4),
// then a face pass: the face is found, redrawn at 1024 px with the same LoRA and pasted back. In a
// full-body render the face is ~130 px wide even after hires, and SDXL draws eyes, ears and mouth badly
// at that size (Rin V2's LoRA test: every full-body image rejected for its eyes, the close-up approved).
// Then a hand pass: every hand ADetailer's hand model finds (tools/hands.py) is redrawn the same way; the
// next LoRA test rejected every nude, POV and parity image for hands. Skipped when the detector is not
// installed.
//
// Machine settings (env): COMFYUI_URL. Character settings (profile options): checkpoint, loras,
// quality, negativeBase, steps, cfg, sampler, scheduler, clipSkip, hires, face, hands, workflow.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { runTool, tiles } from './python.ts';
import type { Backend, Log, RenderOutput, RenderRequest } from './types.ts';

const DEFAULTS = {
  checkpoint: 'waiIllustriousSDXL_v170.safetensors',
  quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest',
  negativeBase:
    'bad quality, worst quality, worst detail, sketch, censor, lowres, bad anatomy, bad hands, extra fingers, missing fingers, ' +
    'text, watermark, signature, multiple views, split screen, loli, child, underage',
  steps: 28,
  cfg: 6,
  sampler: 'euler_ancestral',
  scheduler: 'normal',
  clipSkip: 2,
  hires: { scale: 1.5, denoise: 0.4, steps: 20 } as { scale: number; denoise: number; steps: number } | false,
  /** the face pass: crop `context` x the face, redraw at `size` px at `denoise`, paste back feathered */
  face: { denoise: 0.5, size: 1024, context: 1.6, steps: 24 } as { denoise: number; size: number; context: number; steps: number } | false,
  /** the hand pass: each hand found at `conf` or more (at most `max`), cropped at `context` x its box, redrawn the same way */
  hands: { denoise: 0.45, size: 1024, context: 1.8, steps: 24, conf: 0.35, max: 4 } as
    | { denoise: number; size: number; context: number; steps: number; conf: number; max: number }
    | false,
  timeoutSec: 600,
};

type Opts = typeof DEFAULTS & { url: string; loras: { name: string; weight: number }[]; workflow?: string };

function opts(o: Record<string, unknown>): Opts {
  return { ...DEFAULTS, url: process.env.COMFYUI_URL ?? '', loras: [], ...o } as Opts;
}

async function call(base: string, path: string, init?: RequestInit) {
  const res = await fetch(base.replace(/\/$/, '') + path, init);
  if (!res.ok) throw new Error(`ComfyUI ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function upload(base: string, file: string): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([await readFile(file)]), basename(file));
  form.append('overwrite', 'true');
  return ((await (await call(base, '/upload/image', { method: 'POST', body: form })).json()) as { name: string }).name;
}

/** The default text-to-image (or image-to-image) graph, in ComfyUI's API format. */
export function buildGraph(o: Opts, req: RenderRequest, seed: number, initName?: string, maskName?: string) {
  const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
  let id = 0;
  const add = (class_type: string, inputs: Record<string, unknown>) => {
    g[String(++id)] = { class_type, inputs };
    return String(id);
  };
  const ckpt = add('CheckpointLoaderSimple', { ckpt_name: o.checkpoint });
  let model: [string, number] = [ckpt, 0];
  let clip: [string, number] = [ckpt, 1];
  for (const l of o.loras) {
    const n = add('LoraLoader', { model, clip, lora_name: l.name, strength_model: l.weight, strength_clip: l.weight });
    model = [n, 0];
    clip = [n, 1];
  }
  const skip = add('CLIPSetLastLayer', { clip, stop_at_clip_layer: -Math.abs(o.clipSkip) });
  const pos = add('CLIPTextEncode', { clip: [skip, 0], text: [o.quality, req.prompt].filter(Boolean).join(', ') });
  const neg = add('CLIPTextEncode', { clip: [skip, 0], text: [o.negativeBase, req.negative].filter(Boolean).join(', ') });
  const vae: [string, number] = [ckpt, 2];
  let latent: [string, number];
  let positive: [string, number] = [pos, 0];
  let negative: [string, number] = [neg, 0];
  if (initName && maskName) {
    // inpaint: the mask's soft edge becomes a per-pixel denoise (DifferentialDiffusion)
    const img = add('LoadImage', { image: initName });
    const mask = add('LoadImageMask', { image: maskName, channel: 'red' });
    const cond = add('InpaintModelConditioning', { positive, negative, vae, pixels: [img, 0], mask: [mask, 0], noise_mask: true });
    positive = [cond, 0];
    negative = [cond, 1];
    latent = [cond, 2];
    model = [add('DifferentialDiffusion', { model }), 0];
  } else if (initName) {
    const img = add('LoadImage', { image: initName });
    latent = [add('VAEEncode', { pixels: [img, 0], vae }), 0];
  } else {
    latent = [add('EmptyLatentImage', { width: req.width ?? 832, height: req.height ?? 1216, batch_size: 1 }), 0];
  }
  const sample = (lat: [string, number], steps: number, denoise: number) =>
    add('KSampler', { model, positive, negative, seed, steps, cfg: o.cfg, sampler_name: o.sampler, scheduler: o.scheduler, denoise, latent_image: lat });
  const first = maskName ? req.denoise ?? 1 : initName ? req.denoise ?? 0.5 : 1;
  let image: [string, number] = [add('VAEDecode', { samples: [sample(latent, o.steps, first), 0], vae }), 0];
  if (o.hires && !initName) {
    const up = add('ImageScaleBy', { image, upscale_method: 'lanczos', scale_by: o.hires.scale });
    const enc = add('VAEEncode', { pixels: [up, 0], vae });
    image = [add('VAEDecode', { samples: [sample([enc, 0], o.hires.steps, o.hires.denoise), 0], vae }), 0];
  }
  add('SaveImage', { filename_prefix: 'charforge', images: image });
  return g;
}

/** A user workflow (API format) with %prompt% %negative% %seed% %width% %height% %init% placeholders. */
async function templateGraph(path: string, o: Opts, req: RenderRequest, seed: number, initName?: string) {
  const values: Record<string, string | number> = {
    prompt: [o.quality, req.prompt].filter(Boolean).join(', '),
    negative: [o.negativeBase, req.negative].filter(Boolean).join(', '),
    seed, width: req.width ?? 832, height: req.height ?? 1216, init: initName ?? '', denoise: req.denoise ?? 0.5,
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = v.match(/^%(\w+)%$/);
      if (whole && whole[1] in values) return values[whole[1]];
      return v.replace(/%(\w+)%/g, (m, k: string) => (k in values ? String(values[k]) : m));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(JSON.parse(await readFile(path, 'utf8')));
}

/**
 * Inpaint results go through the VAE, which shifts every pixel a little: blend the result back over the
 * original through the mask, so outside it the picture is exactly the one sent (heads, hands, ornaments).
 */
async function keepOutsideMask(init: string, result: Uint8Array, mask: string): Promise<Buffer> {
  const { width, height } = await sharp(init).metadata();
  const alpha = await sharp(mask).resize(width, height).greyscale().toColourspace('b-w').raw().toBuffer();
  const top = await sharp(result).resize(width, height).removeAlpha().joinChannel(alpha, { raw: { width: width!, height: height!, channels: 1 } }).png().toBuffer();
  return sharp(init).removeAlpha().composite([{ input: top }]).png().toBuffer();
}

/** Queue a graph and return the image it saved. */
async function runGraph(o: Opts, graph: unknown, log: Log, what: string): Promise<Uint8Array> {
  const { prompt_id } = (await (await call(o.url, '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }) })).json()) as { prompt_id: string };
  log(`comfyui: queued ${prompt_id} (${what})`);
  const deadline = Date.now() + o.timeoutSec * 1000;
  let images: { filename: string; subfolder: string; type: string }[] = [];
  for (;;) {
    const h = (await (await call(o.url, `/history/${prompt_id}`)).json()) as Record<string, { status?: { completed?: boolean; status_str?: string }; outputs?: Record<string, { images?: typeof images }> }>;
    const entry = h[prompt_id];
    if (entry?.status?.status_str === 'error') throw new Error(`ComfyUI failed: ${JSON.stringify(entry.status).slice(0, 400)}`);
    if (entry?.status?.completed) {
      images = Object.values(entry.outputs ?? {}).flatMap((n) => n.images ?? []).filter((im) => im.type === 'output');
      break;
    }
    if (Date.now() > deadline) throw new Error(`ComfyUI timed out after ${o.timeoutSec}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!images.length) throw new Error('ComfyUI returned no image');
  const im = images[images.length - 1];
  const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder, type: im.type });
  return new Uint8Array(await (await call(o.url, `/view?${q}`)).arrayBuffer());
}

const FRAMING = /^(full body|cowboy shot|upper body|lower body|wide shot|very wide shot|portrait|close-up|from below|from above|feet out of frame|head out of frame)$/;

/** The render's prompt for a face crop: the same tags without the framing, plus a close-up framing. */
export function facePrompt(prompt: string): string {
  const tags = prompt.split(',').map((t) => t.trim()).filter((t) => t && !FRAMING.test(t.toLowerCase()));
  return [...tags, 'portrait, close-up, face focus, detailed eyes, detailed face'].join(', ');
}

/** The render's prompt for a hand crop. */
export function handPrompt(prompt: string): string {
  const tags = prompt.split(',').map((t) => t.trim()).filter((t) => t && !FRAMING.test(t.toLowerCase()));
  return [...tags, 'close-up, hand focus, detailed hand, five fingers, detailed fingers, fingernails'].join(', ');
}

/**
 * Redraw a square region of `file` in place: crop it, upscale to `size`, img2img with the render's LoRA
 * and a deterministic sampler, scale back and paste it with a feathered ellipse. Returns the region.
 */
async function redrawRegion(o: Opts, req: RenderRequest, file: string, seed: number, log: Log, r: {
  cx: number; cy: number; side: number; prompt: string; negative: string; denoise: number; size: number; steps: number; what: string;
}): Promise<[number, number, number, number]> {
  const m = await sharp(file).metadata();
  const W = m.width ?? 0;
  const H = m.height ?? 0;
  const side = Math.round(Math.min(W, H, r.side));
  const left = Math.round(Math.min(Math.max(r.cx - side / 2, 0), W - side));
  const top = Math.round(Math.min(Math.max(r.cy - side / 2, 0), H - side));
  // the crop is a working file: never next to the output, where a glob for the picture would find it
  const work = await mkdtemp(join(tmpdir(), 'charforge-detail-'));
  try {
    const crop = join(work, 'crop.png');
    await sharp(file).extract({ left, top, width: side, height: side }).resize(r.size, r.size, { kernel: 'lanczos3' }).png().toFile(crop);
    const name = await upload(o.url, crop);
    const fo: Opts = { ...o, hires: false, steps: r.steps, sampler: 'dpmpp_2m', scheduler: 'karras' };
    const graph = buildGraph(fo, { ...req, prompt: r.prompt, negative: r.negative, width: r.size, height: r.size, denoise: r.denoise }, seed, name);
    const drawn = await runGraph(fo, graph, log, `${r.what}, seed ${seed}`);
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><defs><filter id="f"><feGaussianBlur stdDeviation="${side * 0.05}"/></filter></defs><ellipse cx="${side / 2}" cy="${side / 2}" rx="${side * 0.38}" ry="${side * 0.42}" fill="#fff" filter="url(#f)"/></svg>`);
    const patch = await sharp(await sharp(drawn).resize(side, side, { kernel: 'lanczos3' }).ensureAlpha().png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    await writeFile(file, await sharp(file).composite([{ input: patch, left, top }]).png().toBuffer());
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return [left, top, left + side, top + side];
}

/** The face pass: the most confident face (1.8 or more), redrawn at `face.size` px. */
async function facePass(o: Opts, req: RenderRequest, file: string, seed: number, log: Log): Promise<Record<string, unknown> | null> {
  if (!o.face) return null;
  const found = (await tiles(['face', file])) as { face: [number, number, number, number] | null };
  if (!found.face) {
    log('comfyui: face pass skipped (no face found)');
    return null;
  }
  const [fx, fy, fw, fh] = found.face;
  const box = await redrawRegion(o, req, file, seed, log, {
    cx: fx + fw / 2, cy: fy + fh / 2, side: Math.max(fw, fh) * o.face.context, prompt: facePrompt(req.prompt), negative: req.negative ?? '',
    denoise: o.face.denoise, size: o.face.size, steps: o.face.steps, what: 'face pass',
  });
  return { box, denoise: o.face.denoise, size: o.face.size };
}

const HAND_NEGATIVE = 'extra fingers, missing fingers, fused fingers, extra digits, fewer digits, bad hands, deformed hands';

/** The hand pass: every hand the detector finds, most confident first, each redrawn at `hands.size` px. */
async function handPass(o: Opts, req: RenderRequest, file: string, seed: number, log: Log): Promise<Record<string, unknown>[] | null> {
  if (!o.hands) return null;
  const found = (await runTool('hands.py', [file, '--conf', String(o.hands.conf)])) as { hands: number[][]; error?: string };
  if (found.error) {
    log(`comfyui: hand pass skipped (${found.error})`);
    return null;
  }
  const done: Record<string, unknown>[] = [];
  for (const [i, [x0, y0, x1, y1, conf]] of found.hands.slice(0, o.hands.max).entries()) {
    const box = await redrawRegion(o, req, file, seed + 1 + i, log, {
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, side: Math.max(x1 - x0, y1 - y0, 64) * o.hands.context, prompt: handPrompt(req.prompt),
      negative: [req.negative, HAND_NEGATIVE].filter(Boolean).join(', '), denoise: o.hands.denoise, size: o.hands.size, steps: o.hands.steps,
      what: `hand pass ${i + 1}`,
    });
    done.push({ box, found: [x0, y0, x1, y1], conf });
  }
  return done;
}

export const comfyui: Backend = {
  id: 'comfyui',
  label: 'GPU local (ComfyUI)',
  allowsNsfw: () => true,
  unavailable: (o) => (opts(o).url ? null : 'set COMFYUI_URL (for example http://127.0.0.1:8188)'),
  async render(req, options, outDir, log) {
    const o = opts({ ...options, ...req.options });
    const initName = req.init ? await upload(o.url, req.init) : undefined;
    if (req.mask && !req.init) throw new Error('a mask needs the picture it applies to (init)');
    const maskName = req.mask ? await upload(o.url, req.mask) : undefined;
    const out: RenderOutput[] = [];
    const count = req.count ?? 1;
    const first = req.seed ?? Math.floor(Math.random() * 2 ** 31);
    for (let i = 0; i < count; i++) {
      const seed = first + i;
      const graph = o.workflow ? await templateGraph(o.workflow, o, req, seed, initName) : buildGraph(o, req, seed, initName, maskName);
      const data = await runGraph(o, graph, log, `seed ${seed}`);
      const file = join(outDir, `comfyui-${seed}.png`);
      await writeFile(file, maskName ? await keepOutsideMask(req.init!, data, req.mask!) : data);
      // the face pass belongs to a new picture; an img2img (finishing tiles, edits) keeps its face as sent
      const fresh = !initName && !o.workflow;
      const face = fresh ? await facePass(o, req, file, seed, log) : null;
      const hands = fresh ? await handPass(o, req, file, seed, log) : null;
      const m = await sharp(file).metadata();
      out.push({ file, width: m.width ?? 0, height: m.height ?? 0, seed, backend: 'comfyui', meta: { checkpoint: o.checkpoint, loras: o.loras, steps: o.steps, cfg: o.cfg, hires: o.hires, face, hands } });
    }
    return out;
  },
};
