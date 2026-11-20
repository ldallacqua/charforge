// The owner's local Codex CLI, logged in with a ChatGPT plan: it generates with the built-in image tool,
// so no API key is needed (this is how Siren Siege's art was made). SFW only. About 60-100 s per image.
// The image is taken from the run's own session folder, so parallel runs (finishing tiles) never swap.
//
// Machine settings (env): CODEX_BIN. Found automatically on PATH or inside the ChatGPT app on macOS.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import sharp from 'sharp';
import type { Backend, RenderOutput, RenderRequest } from './types.ts';

const APP_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';

export function findCodex(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.CODEX_BIN) return existsSync(process.env.CODEX_BIN) ? process.env.CODEX_BIN : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && existsSync(join(dir, 'codex'))) return join(dir, 'codex');
  return existsSync(APP_BIN) ? APP_BIN : null;
}

function orientation(req: RenderRequest): string {
  const w = req.width ?? 1024;
  const h = req.height ?? 1536;
  if (w > h * 1.15) return 'landscape 3:2 (1536x1024)';
  if (h > w * 1.15) return 'portrait 2:3 (1024x1536)';
  return 'square (1024x1024)';
}

export function codexRequest(req: RenderRequest, refs: string[]): string {
  if (req.edit && req.init) {
    // Edit mode (finishing tiles): the attached image is the image tool's input image. Worded as in
    // Siren Siege's gpt_tiles.sh, which is what made the tool redraw instead of re-imagining.
    return [
      `Call your built-in image generation tool exactly once, with the attached image (also at ./ref/${basename(req.init)}) as the input image${req.transparent ? ' and with transparent_background set to true' : ''}, and use this instruction for it: '${req.prompt.replace(/'/g, '’')}'`,
      'Then copy the PNG the tool saved for that call (its exact saved path, nothing else) to ./out/image.png, unchanged and with its alpha channel, and stop.',
      'Do not write or run any code that creates or edits images. The only command you may run is the file copy. Do not read or change any other file.',
    ].join(' ');
  }
  return [
    'Use your built-in image generation tool to create exactly ONE image.',
    'Then copy the PNG file to ./out/image.png and do nothing else. Do not create or change any other file.',
    `Orientation and size: ${orientation(req)}.`,
    req.transparent ? 'Background: transparent PNG (no background at all).' : 'Background: plain flat white unless the description says otherwise.',
    refs.length ? `Reference images, keep this exact character design (face, hair, outfit, colours): ${refs.map((r) => `./ref/${r}`).join(', ')}.` : '',
    '',
    'Image description:',
    req.prompt,
    req.negative ? `\nAvoid: ${req.negative}` : '',
  ].filter((l) => l !== '').join('\n');
}

function run(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    const t = setTimeout(() => {
      p.kill('SIGTERM');
      reject(new Error(`codex timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve(log) : reject(new Error(`codex exited with ${code}: ${log.slice(-600)}`));
    });
    p.stdin.end(input);
  });
}

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The session this run created: the rollout (CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl)
 * whose first line names this run's working directory. Runs go in parallel (finishing tiles), so
 * "the newest image" is not this run's image; the session is.
 */
export async function sessionOf(wd: string, since: number): Promise<string | null> {
  const root = join(codexHome(), 'sessions');
  const days = new Set<string>();
  for (let t = since - 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    days.add(join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  const needles = [`"cwd":${JSON.stringify(wd)}`, `/${basename(wd)}"`];
  for (const day of days) {
    const dir = join(root, day);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      const id = /^rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(f)?.[1];
      if (!id || (await stat(join(dir, f))).mtimeMs < since - 5_000) continue;
      const fh = await open(join(dir, f));
      try {
        const { bytesRead, buffer } = await fh.read(Buffer.alloc(4096), 0, 4096, 0);
        const head = buffer.subarray(0, bytesRead).toString('utf8');
        if (needles.some((n) => head.includes(n))) return id;
      } finally {
        await fh.close();
      }
    }
  }
  return null;
}

/** The newest image the image tool saved in this session (CODEX_HOME/generated_images/<session>/). */
async function sessionImage(id: string | null): Promise<string | null> {
  if (!id) return null;
  const dir = join(codexHome(), 'generated_images', id);
  if (!existsSync(dir)) return null;
  let best: { f: string; t: number } | null = null;
  for (const f of await readdir(dir)) {
    if (!/\.(png|webp|jpe?g)$/i.test(f)) continue;
    const t = (await stat(join(dir, f))).mtimeMs;
    if (!best || t > best.t) best = { f: join(dir, f), t };
  }
  return best?.f ?? null;
}

export const codex: Backend = {
  id: 'codex',
  label: 'Codex CLI (plano do ChatGPT)',
  allowsNsfw: () => false,
  unavailable: (o) => (findCodex(o.bin as string | undefined) ? null : 'Codex CLI not found: install it or set CODEX_BIN'),
  async render(req, options, outDir, log) {
    const bin = findCodex(options.bin as string | undefined)!;
    const timeoutMs = Number(options.timeoutSec ?? 420) * 1000;
    const out: RenderOutput[] = [];
    for (let i = 0; i < (req.count ?? 1); i++) {
      const wd = await mkdtemp(join(tmpdir(), 'charforge-codex-'));
      try {
        await mkdir(join(wd, 'out'));
        const refs: string[] = [];
        for (const f of [...(req.init ? [req.init] : []), ...(req.references ?? [])]) {
          await mkdir(join(wd, 'ref'), { recursive: true });
          await copyFile(f, join(wd, 'ref', basename(f)));
          refs.push(basename(f));
        }
        const request = codexRequest(req, refs);
        await writeFile(join(wd, 'request.txt'), request);
        const started = Date.now();
        log(`codex: image ${i + 1}/${req.count ?? 1} (about a minute)`);
        const attach = req.edit && req.init ? ['--image', join(wd, 'ref', basename(req.init)), '--'] : [];
        await run(bin, ['exec', '-C', wd, '--approve-for-me', '--skip-git-repo-check', ...attach, '-'], request, timeoutMs);
        // The image the tool saved in this run's own session is the truth: the agent's copy to ./out
        // has been seen to grab another parallel run's image. ./out only when the session is not found.
        const fromSession = await sessionImage(await sessionOf(wd, started));
        const made = (await readdir(join(wd, 'out'))).filter((f) => /\.(png|webp|jpe?g)$/i.test(f));
        const src = fromSession ?? (made.length ? join(wd, 'out', made[0]) : null);
        if (!src) throw new Error('codex finished but no image was found');
        const file = join(outDir, `codex-${Date.now()}-${i}.png`);
        await sharp(src).png().toFile(file);
        const m = await sharp(file).metadata();
        out.push({ file, width: m.width ?? 0, height: m.height ?? 0, backend: 'codex', meta: { request } });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
    return out;
  },
};
