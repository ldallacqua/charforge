// `command`: any other image CLI (another agent's CLI, a local script, a different service).
// `mock`: placeholder images for tests and dry runs.

import { spawn } from 'node:child_process';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Backend, RenderOutput } from './types.ts';

/**
 * options.command: argv with placeholders {prompt_file} {negative} {out_dir} {width} {height} {count} {seed}.
 * Every PNG the command writes into {out_dir} becomes an output. options.nsfw: true only for a command that
 * runs a local model (the owner's choice; cloud CLIs must stay false).
 */
export const command: Backend = {
  id: 'command',
  label: 'Outro comando local',
  allowsNsfw: (o) => o.nsfw === true,
  unavailable: (o) => (Array.isArray(o.command) && o.command.length ? null : 'set options.command (argv array) in the profile'),
  async render(req, options, outDir, log) {
    const argv = options.command as string[];
    const work = join(outDir, `cmd-${Date.now()}`);
    await mkdir(work, { recursive: true });
    const promptFile = join(work, 'prompt.txt');
    await writeFile(promptFile, req.prompt);
    const values: Record<string, string> = {
      prompt_file: promptFile, negative: req.negative ?? '', out_dir: work,
      width: String(req.width ?? 1024), height: String(req.height ?? 1536), count: String(req.count ?? 1), seed: String(req.seed ?? ''),
    };
    const args = argv.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m));
    log(`command: ${args[0]}`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      p.stdout.on('data', (d) => (tail = (tail + d).slice(-800)));
      p.stderr.on('data', (d) => (tail = (tail + d).slice(-800)));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`command exited with ${code}: ${tail}`))));
    });
    const out: RenderOutput[] = [];
    for (const f of (await readdir(work)).filter((x) => /\.png$/i.test(x))) {
      const m = await sharp(join(work, f)).metadata();
      out.push({ file: join(work, f), width: m.width ?? 0, height: m.height ?? 0, backend: 'command', meta: {} });
    }
    if (!out.length) throw new Error('command wrote no PNG into {out_dir}');
    return out;
  },
};

export const mock: Backend = {
  id: 'mock',
  label: 'Simulado (testes)',
  allowsNsfw: () => true,
  unavailable: () => null,
  async render(req, _options, outDir) {
    const out: RenderOutput[] = [];
    const w = req.width ?? 512;
    const h = req.height ?? 768;
    for (let i = 0; i < (req.count ?? 1); i++) {
      const seed = (req.seed ?? 1000) + i;
      const hue = (seed * 47) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue},35%,55%)"/><text x="50%" y="50%" font-size="${Math.round(w / 12)}" text-anchor="middle" fill="#fff" font-family="sans-serif">mock ${seed}</text></svg>`;
      const file = join(outDir, `mock-${seed}.png`);
      await sharp(Buffer.from(svg)).png().toFile(file);
      out.push({ file, width: w, height: h, seed, backend: 'mock', meta: {} });
    }
    return out;
  },
};
