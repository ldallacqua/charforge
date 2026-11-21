// OpenAI Images API (GPT Image). SFW only: the provider refuses explicit content.
// Machine settings (env): OPENAI_API_KEY (never stored by Charforge), OPENAI_BASE_URL, OPENAI_IMAGE_MODEL.
// Character settings: model, quality, size.
//
// gpt-image-1 was shut down on 2026-10-23. The default is gpt-image-2.5-sunburst, which takes any
// WIDTHxHEIGHT divisible by 16 (aspect 1:3 to 3:1); up to 2560x1440 worth of pixels is used here, as
// above that the API calls it experimental. Other models get the closest standard size
// (1024x1024, 1024x1536, 1536x1024). `size` in the options overrides both.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import type { Backend, RenderOutput } from './types.ts';

export const DEFAULT_MODEL = 'gpt-image-2.5-sunburst';

/** Models that take arbitrary sizes, per the API reference (2.6 is not listed there). */
const anySize = (model: string) => /^gpt-image-2(-\d{4}-\d{2}-\d{2})?$|^gpt-image-2\.5-/.test(model);

export function pickSize(model: string, w = 1024, h = 1536): string {
  if (anySize(model)) {
    // the request's exact shape, with at least the pixels of 1024x1536 (smaller only loses detail)
    const r = Math.min(3, Math.max(1 / 3, w / h));
    const area = Math.min(2560 * 1440, Math.max(1024 * 1536, w * h));
    const sixteen = (v: number) => Math.max(16, Math.floor(v / 16) * 16);
    const width = sixteen(Math.min(3840, Math.sqrt(area * r)));
    return `${width}x${sixteen(Math.min(3840, width / r))}`;
  }
  if (w > h * 1.15) return '1536x1024';
  if (h > w * 1.15) return '1024x1536';
  return '1024x1024';
}

export const openai: Backend = {
  id: 'openai',
  label: 'API da OpenAI (GPT Image)',
  allowsNsfw: () => false,
  unavailable: () => (process.env.OPENAI_API_KEY ? null : 'set OPENAI_API_KEY in the environment (never in the profile)'),
  async render(req, options, outDir, log) {
    const o = { model: process.env.OPENAI_IMAGE_MODEL ?? DEFAULT_MODEL, quality: 'high', ...options, ...req.options } as Record<string, string>;
    const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const size = o.size ?? pickSize(o.model, req.width, req.height);
    const prompt = req.negative ? `${req.prompt}\n\nAvoid: ${req.negative}` : req.prompt;
    const images = [...(req.init ? [req.init] : []), ...(req.references ?? [])];
    const headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
    const background = req.transparent ? 'transparent' : 'auto';
    let res: Response;
    if (images.length) {
      const form = new FormData();
      form.append('model', o.model);
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('quality', o.quality);
      form.append('background', background);
      form.append('n', String(req.count ?? 1));
      // keeps faces from the input image; only gpt-image-1.5 takes it (newer models match by default)
      if (o.model.startsWith('gpt-image-1.5')) form.append('input_fidelity', 'high');
      for (const f of images) form.append('image[]', new Blob([await readFile(f)], { type: 'image/png' }), basename(f));
      res = await fetch(`${base}/images/edits`, { method: 'POST', headers, body: form });
    } else {
      res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: o.model, prompt, size, quality: o.quality, background, n: req.count ?? 1, output_format: 'png' }),
      });
    }
    const body = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`OpenAI: ${body.error?.message ?? `HTTP ${res.status}`}`);
    const out: RenderOutput[] = [];
    for (const [i, d] of (body.data ?? []).entries()) {
      if (!d.b64_json) continue;
      const data = Buffer.from(d.b64_json, 'base64');
      const file = join(outDir, `openai-${Date.now()}-${i}.png`);
      await writeFile(file, data);
      const m = await sharp(data).metadata();
      out.push({ file, width: m.width ?? 0, height: m.height ?? 0, backend: 'openai', meta: { model: o.model, size, quality: o.quality } });
    }
    log(`openai: ${out.length} image(s) from ${o.model}`);
    if (!out.length) throw new Error('OpenAI returned no image');
    return out;
  },
};
