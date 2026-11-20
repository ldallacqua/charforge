// Local GPU through ComfyUI's HTTP API. SFW and NSFW. Default graph: SDXL/Illustrious checkpoint,
// optional LoRAs, clip skip, a base pass and a hires pass (upscale 1.5x + 20 steps at denoise 0.4),
// which is the finishing that makes the difference between "AI-looking" and clean art.
//
// Machine settings (env): COMFYUI_URL. Character settings (profile options): checkpoint, loras,
// quality, negativeBase, steps, cfg, sampler, scheduler, clipSkip, hires, workflow.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import type { Backend, RenderOutput, RenderRequest } from './types.ts';

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
      const { prompt_id } = (await (await call(o.url, '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }) })).json()) as { prompt_id: string };
      log(`comfyui: queued ${prompt_id} (seed ${seed})`);
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
      const data = new Uint8Array(await (await call(o.url, `/view?${q}`)).arrayBuffer());
      const file = join(outDir, `comfyui-${seed}.png`);
      await writeFile(file, data);
      const m = await sharp(data).metadata();
      out.push({ file, width: m.width ?? 0, height: m.height ?? 0, seed, backend: 'comfyui', meta: { checkpoint: o.checkpoint, loras: o.loras, steps: o.steps, cfg: o.cfg, hires: o.hires } });
    }
    return out;
  },
};
