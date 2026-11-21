// Local GPU through ComfyUI's HTTP API. SFW and NSFW. Default graph: SDXL/Illustrious checkpoint,
// optional LoRAs, clip skip, a base pass and a hires pass (upscale 1.5x + 20 steps at denoise 0.4),
// then a face pass: the face is found, redrawn at 1024 px with the same LoRA and pasted back. In a
// full-body render the face is ~130 px wide even after hires, and SDXL draws eyes, ears and mouth badly
// at that size (Rin V2's LoRA test: every full-body image rejected for its eyes, the close-up approved).
//
// Machine settings (env): COMFYUI_URL. Character settings (profile options): checkpoint, loras,
// quality, negativeBase, steps, cfg, sampler, scheduler, clipSkip, hires, face, workflow.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { tiles } from './python.ts';
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
export function buildGraph(o: Opts, req: RenderRequest, seed: number, initName?: string) {
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
  if (initName) {
    const img = add('LoadImage', { image: initName });
    latent = [add('VAEEncode', { pixels: [img, 0], vae }), 0];
  } else {
    latent = [add('EmptyLatentImage', { width: req.width ?? 832, height: req.height ?? 1216, batch_size: 1 }), 0];
  }
  const sample = (lat: [string, number], steps: number, denoise: number) =>
    add('KSampler', { model, positive: [pos, 0], negative: [neg, 0], seed, steps, cfg: o.cfg, sampler_name: o.sampler, scheduler: o.scheduler, denoise, latent_image: lat });
  let image: [string, number] = [add('VAEDecode', { samples: [sample(latent, o.steps, initName ? req.denoise ?? 0.5 : 1), 0], vae }), 0];
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

/** Redraw the face of `file` in place: crop, upscale, img2img with the same LoRA, feathered paste. */
async function facePass(o: Opts, req: RenderRequest, file: string, seed: number, log: Log): Promise<Record<string, unknown> | null> {
  if (!o.face) return null;
  const found = (await tiles(['face', file])) as { face: [number, number, number, number] | null };
  if (!found.face) {
    log('comfyui: face pass skipped (no face found)');
    return null;
  }
  const [fx, fy, fw, fh] = found.face;
  const m = await sharp(file).metadata();
  const W = m.width ?? 0;
  const H = m.height ?? 0;
  const side = Math.round(Math.min(W, H, Math.max(fw, fh) * o.face.context));
  const left = Math.round(Math.min(Math.max(fx + fw / 2 - side / 2, 0), W - side));
  const top = Math.round(Math.min(Math.max(fy + fh / 2 - side / 2, 0), H - side));
  const crop = `${file}.face.png`;
  await sharp(file).extract({ left, top, width: side, height: side }).resize(o.face.size, o.face.size, { kernel: 'lanczos3' }).png().toFile(crop);
  const name = await upload(o.url, crop);
  const fo: Opts = { ...o, hires: false, steps: o.face.steps, sampler: 'dpmpp_2m', scheduler: 'karras' };
  const graph = buildGraph(fo, { ...req, prompt: facePrompt(req.prompt), width: o.face.size, height: o.face.size, denoise: o.face.denoise }, seed, name);
  const drawn = await runGraph(fo, graph, log, `face pass, seed ${seed}`);
  // feathered ellipse: the redraw replaces the face and fades out before the crop's edge
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><defs><filter id="f"><feGaussianBlur stdDeviation="${side * 0.05}"/></filter></defs><ellipse cx="${side / 2}" cy="${side / 2}" rx="${side * 0.38}" ry="${side * 0.42}" fill="#fff" filter="url(#f)"/></svg>`);
  const patch = await sharp(await sharp(drawn).resize(side, side, { kernel: 'lanczos3' }).ensureAlpha().png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const merged = await sharp(file).composite([{ input: patch, left, top }]).png().toBuffer();
  await writeFile(file, merged);
  return { box: [left, top, left + side, top + side], denoise: o.face.denoise, size: o.face.size };
}

export const comfyui: Backend = {
  id: 'comfyui',
  label: 'GPU local (ComfyUI)',
  allowsNsfw: () => true,
  unavailable: (o) => (opts(o).url ? null : 'set COMFYUI_URL (for example http://127.0.0.1:8188)'),
  async render(req, options, outDir, log) {
    const o = opts({ ...options, ...req.options });
    const initName = req.init ? await upload(o.url, req.init) : undefined;
    const out: RenderOutput[] = [];
    const count = req.count ?? 1;
    const first = req.seed ?? Math.floor(Math.random() * 2 ** 31);
    for (let i = 0; i < count; i++) {
      const seed = first + i;
      const graph = o.workflow ? await templateGraph(o.workflow, o, req, seed, initName) : buildGraph(o, req, seed, initName);
      const data = await runGraph(o, graph, log, `seed ${seed}`);
      const file = join(outDir, `comfyui-${seed}.png`);
      await writeFile(file, data);
      // the face pass belongs to a new picture; an img2img (finishing tiles, edits) keeps its face as sent
      const face = !initName && !o.workflow ? await facePass(o, req, file, seed, log) : null;
      const m = await sharp(file).metadata();
      out.push({ file, width: m.width ?? 0, height: m.height ?? 0, seed, backend: 'comfyui', meta: { checkpoint: o.checkpoint, loras: o.loras, steps: o.steps, cfg: o.cfg, hires: o.hires, face } });
    }
    return out;
  },
};
