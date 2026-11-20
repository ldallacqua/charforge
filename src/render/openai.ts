// OpenAI Images API (GPT Image). SFW only: the provider refuses explicit content.
// Machine settings (env): OPENAI_API_KEY (never stored by Charforge), OPENAI_BASE_URL, OPENAI_IMAGE_MODEL.
// Character settings: model, quality, size.
//
// Sizes are the API's own (1024x1024, 1024x1536, 1536x1024, or larger on newer models); the request's
// aspect ratio picks the closest one unless `size` is set. For a high-resolution final, render here and
// upscale locally, or tile (see docs/RENDERING.md).

import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import type { Backend, RenderOutput } from './types.ts';

function pickSize(w = 1024, h = 1536): string {
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
    const o = { model: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1', quality: 'high', ...options, ...req.options } as Record<string, string>;
    const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const size = o.size ?? pickSize(req.width, req.height);
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
