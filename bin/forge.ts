#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// forge: the agent's side of the studio. Works the same for any agent (Claude, Codex, Gemini...) and lets
// any of them resume a character from its state alone.
//
//   forge next <slug> [--json]                what to do now, for the agent and for the owner
//   forge status [--char <slug>]
//   forge char add <slug> --name <name> [--brief <text|@file>] [--preset <id>] [--adult]
//   forge char brief <slug> <text|@file>
//   forge char cover <slug> <itemId>
//   forge profile <slug> [--preset <id>] [--sfw <backend>] [--nsfw <backend|none>] [--sfw-opt k=v]... [--nsfw-opt k=v]...
//   forge render --char <slug> --rating sfw|nsfw --prompt <text|@file> [--negative ...] [--n 4] [--size 768x1344]
//                [--seed N] [--init img [--mask mask.png]] [--denoise 0.5] [--ref img]... [--transparent] [--opt k=v]... [--out dir]
//                (--mask: inpaint on comfyui, white = redraw; outside the mask the picture is kept exactly)
//                [--submit --phase g2 --title "..." [--group ...] [--kind review|pick]]
//   forge finish --char <slug> --item <id> [--backend codex|comfyui] [--rating sfw|nsfw] [--face x0,y0,x1,y1]
//   forge finish --char <slug> --init <img> --rating sfw|nsfw [--backend ...] [--prompt ...] [--out dir]
//                enlarge 2x by redrawing in tiles (GPT or local SDXL); --item queues it, --init runs it here
//   forge submit --char <slug> --phase g5 --title "..." [--kind review|pick] [--notes <text|@file>]
//                [--parent <batchId>] (--manifest <file.json> | <image> ...)
//   forge wait <batchId> [--timeout <seconds>] [--json]
//   forge verdicts <batchId> [--json]
//   forge gate <slug> <g0..g8> done|open [--note <text>]
//   forge worker [--backends codex,comfyui] [--once]    run queued render jobs on this machine
//   forge serve
//
// FORGE_URL (default http://127.0.0.1:8787) points at the studio. Backend settings come from the
// environment: COMFYUI_URL, OPENAI_API_KEY, CODEX_BIN (see docs/RENDERING.md).

import { existsSync, openAsBlob } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Batch, CharacterDetail, Character, Job, Manifest, ManifestItem, NextStep } from '../src/shared/types.ts';
import { availableBackends, render as renderWith, type BackendConfig, type RenderRequest } from '../src/render/index.ts';
import { FINISH_LABEL, finish as finishWith, finishMode, perform } from '../src/render/finish.ts';
import { localInputs } from '../src/render/inputs.ts';
import { PHASES } from '../src/shared/phases.ts';
import type { VerdictExport } from '../src/server/verdicts.ts';

// Machine settings (COMFYUI_URL, CODEX_BIN, CHARFORGE_PYTHON, FORGE_URL...) from the repository's .env
// (gitignored) when it exists, so a script or a new shell does not run without them: Rin V2's first
// local test failed for a missing COMFYUI_URL. Variables already set in the environment win.
const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const BASE = (process.env.FORGE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch {
    throw new Error(`studio not reachable at ${BASE} (start it with: pnpm start)`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const json = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

function bar(c: Batch['counts']) {
  return `${c.approved} ok · ${c.rejected} recusadas · ${c.pending} pendentes (de ${c.total})`;
}

async function status(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { char: { type: 'string' } } });
  if (values.char) {
    const ch = await api<CharacterDetail>(`/api/characters/${values.char}`);
    console.log(`${ch.name} (${ch.slug})`);
    for (const b of ch.batches) console.log(`  #${b.id} [${b.status}] ${b.phase} r${b.round} ${b.title} — ${bar(b.counts)}`);
    return;
  }
  const { characters, waiting } = await api<{ characters: Character[]; waiting: Batch[] }>('/api/characters');
  console.log(`characters: ${characters.map((c) => c.slug).join(', ') || '(none)'}`);
  console.log(waiting.length ? 'waiting for the owner:' : 'nothing waiting for the owner');
  for (const b of waiting) console.log(`  #${b.id} ${b.characterSlug} ${b.phase} r${b.round} ${b.title} — ${bar(b.counts)}`);
}

const text = async (v: string) => (v.startsWith('@') ? readFile(resolve(v.slice(1)), 'utf8') : v);

async function char(argv: string[]) {
  const [sub, slug, ...rest] = argv;
  if (sub === 'add') {
    const { values } = parseArgs({ args: rest, options: { name: { type: 'string' }, summary: { type: 'string' }, brief: { type: 'string' }, preset: { type: 'string' }, adult: { type: 'boolean' } } });
    const ch = await api<Character>('/api/characters', json({ slug, name: values.name ?? slug, summary: values.summary ?? '', brief: values.brief ? await text(values.brief) : '', preset: values.preset, adult: values.adult }));
    console.log(`created ${ch.slug}${ch.profile ? ` (SFW: ${ch.profile.sfw.backend}, NSFW: ${ch.profile.nsfw?.backend ?? 'none'})` : ''}`);
  } else if (sub === 'brief') {
    await api(`/api/characters/${slug}`, { ...json({ brief: await text(rest.join(' ')) }), method: 'PATCH' });
    console.log(`brief of ${slug} saved`);
  } else if (sub === 'cover') {
    await api(`/api/characters/${slug}`, { ...json({ coverItemId: Number(rest[0]) }), method: 'PATCH' });
    console.log(`cover of ${slug} set to item ${rest[0]}`);
  } else {
    throw new Error('usage: forge char add <slug> --name <name> [--brief ...] [--preset ...] [--adult] | char brief <slug> <text|@file> | char cover <slug> <itemId>');
  }
}

/** k=v pairs; values are JSON when they parse (numbers, booleans, arrays), text otherwise. */
function kv(pairs: string[] = []): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) throw new Error(`expected key=value, got ${p}`);
    const raw = p.slice(i + 1);
    try {
      o[p.slice(0, i)] = JSON.parse(raw);
    } catch {
      o[p.slice(0, i)] = raw;
    }
  }
  return o;
}

async function profile(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { preset: { type: 'string' }, sfw: { type: 'string' }, nsfw: { type: 'string' }, 'sfw-opt': { type: 'string', multiple: true }, 'nsfw-opt': { type: 'string', multiple: true } },
  });
  const slug = positionals[0];
  const ch = await api<CharacterDetail>(`/api/characters/${slug}`);
  let body: Record<string, unknown>;
  if (values.preset) body = { preset: values.preset };
  else {
    const cur = ch.profile ?? { sfw: { backend: 'comfyui' as const }, nsfw: null };
    const sfw = { backend: (values.sfw ?? cur.sfw.backend) as BackendConfig['backend'], options: { ...(values.sfw && values.sfw !== cur.sfw.backend ? {} : cur.sfw.options), ...kv(values['sfw-opt']) } };
    const nsfwName = values.nsfw ?? cur.nsfw?.backend ?? 'none';
    const nsfw = nsfwName === 'none' ? null : { backend: nsfwName as BackendConfig['backend'], options: { ...(values.nsfw && values.nsfw !== cur.nsfw?.backend ? {} : cur.nsfw?.options), ...kv(values['nsfw-opt']) } };
    body = { profile: { sfw, nsfw } };
  }
  const out = await api<Character>(`/api/characters/${slug}`, { ...json(body), method: 'PATCH' });
  console.log(JSON.stringify(out.profile, null, 2));
}

async function renderCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      char: { type: 'string' }, rating: { type: 'string' }, prompt: { type: 'string' }, negative: { type: 'string' }, n: { type: 'string' },
      size: { type: 'string' }, seed: { type: 'string' }, init: { type: 'string' }, mask: { type: 'string' }, denoise: { type: 'string' }, ref: { type: 'string', multiple: true },
      transparent: { type: 'boolean' }, opt: { type: 'string', multiple: true }, out: { type: 'string' }, backend: { type: 'string' },
      submit: { type: 'boolean' }, phase: { type: 'string' }, title: { type: 'string' }, group: { type: 'string' }, kind: { type: 'string' }, notes: { type: 'string' },
    },
  });
  if (!values.prompt) throw new Error('--prompt is required');
  const rating = values.rating === 'nsfw' ? 'nsfw' : 'sfw';
  let config: BackendConfig;
  if (values.backend) config = { backend: values.backend as BackendConfig['backend'] };
  else {
    if (!values.char) throw new Error('--char (to use its profile) or --backend is required');
    const ch = await api<CharacterDetail>(`/api/characters/${values.char}`);
    if (!ch.profile) throw new Error(`${values.char} has no render profile: forge profile ${values.char} --preset ...`);
    const c = ch.profile[rating];
    if (!c) throw new Error(`${values.char} has no ${rating.toUpperCase()} backend`);
    config = c;
  }
  const [w, h] = (values.size ?? '').split('x').map(Number);
  const req: RenderRequest = {
    prompt: await text(values.prompt), negative: values.negative, rating,
    width: w || undefined, height: h || undefined, count: Number(values.n ?? 1), seed: values.seed ? Number(values.seed) : undefined,
    init: values.init ? resolve(values.init) : undefined, mask: values.mask ? resolve(values.mask) : undefined, denoise: values.denoise ? Number(values.denoise) : undefined,
    references: values.ref?.map((r) => resolve(r)), transparent: values.transparent, options: kv(values.opt),
  };
  const out = resolve(values.out ?? join('renders', `${Date.now()}`));
  const t0 = Date.now();
  const outputs = await renderWith(config, req, out, (l) => console.error(l));
  await writeFile(join(out, 'render.json'), JSON.stringify({ config: { backend: config.backend }, request: req, outputs }, null, 2));
  console.error(`${outputs.length} image(s) from ${config.backend} in ${Math.round((Date.now() - t0) / 1000)}s -> ${out}`);
  if (!values.submit) {
    for (const o of outputs) console.log(o.file);
    return;
  }
  if (!values.char || !values.phase || !values.title) throw new Error('--submit needs --char, --phase and --title');
  const manifest = {
    character: values.char, phase: values.phase, kind: values.kind ?? 'review', title: values.title, notes: values.notes ? await text(values.notes) : '',
    items: outputs.map((o, i) => ({ file: o.file, label: o.seed !== undefined ? `seed ${o.seed}` : `${o.backend} ${i + 1}`, group: values.group, meta: { ...o.meta, backend: o.backend, rating, seed: o.seed, request: { ...req, seed: o.seed, count: 1 } } })),
  };
  const mf = join(out, 'manifest.json');
  await writeFile(mf, JSON.stringify(manifest, null, 2));
  await submit(['--manifest', mf]);
}

/**
 * The finishing step (2x in tiles). `--item` queues a job in the studio (a worker runs it, the result
 * arrives as a batch with the item as "before"); `--init` runs it here, like `forge render`.
 */
async function finishCmd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      char: { type: 'string' }, item: { type: 'string' }, init: { type: 'string' }, rating: { type: 'string' }, backend: { type: 'string' },
      scale: { type: 'string' }, face: { type: 'string' }, prompt: { type: 'string' }, negative: { type: 'string' }, seed: { type: 'string' },
      denoise: { type: 'string' }, 'face-denoise': { type: 'string' }, density: { type: 'string' }, opt: { type: 'string', multiple: true },
      out: { type: 'string' }, phase: { type: 'string' }, title: { type: 'string' },
    },
  });
  if (!values.char) throw new Error('--char is required');
  const face = values.face ? (values.face.split(',').map(Number) as [number, number, number, number]) : undefined;
  if (face && (face.length !== 4 || face.some((v) => !Number.isFinite(v)))) throw new Error('--face is x0,y0,x1,y1 in the picture\'s pixels');
  const spec = {
    scale: values.scale ? Number(values.scale) : 2, face,
    denoise: values.denoise ? Number(values.denoise) : undefined, faceDenoise: values['face-denoise'] ? Number(values['face-denoise']) : undefined,
    density: values.density ? Number(values.density) : undefined,
  };
  if (values.item) {
    const job = await api<Job>(`/api/characters/${values.char}/jobs`, json({ fromItem: Number(values.item), finish: spec, backend: values.backend, rating: values.rating, phase: values.phase, title: values.title }));
    console.log(`job #${job.id}: ${FINISH_LABEL[finishMode(job.backend as BackendConfig['backend'])]} (${job.backend}, ${job.rating}); the result arrives as a new batch`);
    return;
  }
  if (!values.init) throw new Error('--item <id> (queue it in the studio) or --init <picture> (run it here) is required');
  if (values.rating !== 'sfw' && values.rating !== 'nsfw') throw new Error('--rating sfw|nsfw is required: NSFW is only ever finished on a local backend');
  const ch = await api<CharacterDetail>(`/api/characters/${values.char}`);
  if (!ch.profile) throw new Error(`${values.char} has no render profile`);
  const own = ch.profile[values.rating];
  if (!own) throw new Error(`${values.char} has no ${values.rating.toUpperCase()} backend`);
  const config: BackendConfig = values.backend && values.backend !== own.backend
    ? { backend: values.backend as BackendConfig['backend'], options: [ch.profile.sfw, ch.profile.nsfw].find((c) => c?.backend === values.backend)?.options ?? {} }
    : own;
  const req: RenderRequest = {
    prompt: values.prompt ? await text(values.prompt) : '', negative: values.negative, rating: values.rating, init: resolve(values.init),
    seed: values.seed ? Number(values.seed) : undefined, options: kv(values.opt), finish: spec,
  };
  const out = resolve(values.out ?? join('renders', `finish-${Date.now()}`));
  const t0 = Date.now();
  const [o] = await finishWith(config, req, out, (l) => console.error(l));
  await writeFile(join(out, 'finish.json'), JSON.stringify({ config: { backend: config.backend }, request: req, output: o }, null, 2));
  console.error(`${o.width}x${o.height} by ${FINISH_LABEL[finishMode(config.backend)]} in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(o.file);
}

async function gate(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { note: { type: 'string' } } });
  const [slug, g, status] = positionals;
  if (!PHASES.some((p) => p.id === g) || (status !== 'done' && status !== 'open')) throw new Error('usage: forge gate <slug> <g0..g8> done|open [--note ...]');
  await api(`/api/characters/${slug}/gates/${g}`, json({ status, note: values.note, by: 'agent' }));
  console.log(`${slug} ${g} ${status}`);
}

async function next(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const n = await api<NextStep>(`/api/characters/${positionals[0]}/next`);
  if (values.json) return console.log(JSON.stringify(n, null, 2));
  const ph = PHASES.find((p) => p.id === n.gate);
  console.log(`${positionals[0]}: ${ph ? `G${ph.gate} ${ph.label}` : 'all gates done'} (${n.state})`);
  if (n.agent) console.log(`\nagent: ${n.agent}`);
  if (n.owner) console.log(`\nowner: ${n.owner}`);
  if (n.commands.length) console.log(`\n${n.commands.map((c) => `  ${c}`).join('\n')}`);
}

async function worker(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { backends: { type: 'string' }, once: { type: 'boolean' }, name: { type: 'string' } } });
  const backends = values.backends ? values.backends.split(',') : availableBackends();
  const name = values.name ?? `forge@${hostname()}`;
  if (!backends.length) throw new Error('no backend available here (set COMFYUI_URL, OPENAI_API_KEY or install the Codex CLI)');
  console.error(`worker ${name}: ${backends.join(', ')}`);
  for (;;) {
    const res = await fetch(`${BASE}/api/jobs/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backends, worker: name }) });
    if (res.status === 204) {
      if (values.once) return;
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!res.ok) throw new Error(`claim failed: HTTP ${res.status}`);
    const { job, config } = (await res.json()) as { job: Job; config: BackendConfig };
    console.error(`job #${job.id}: ${job.backend} ${job.rating} x${job.request.count ?? 1} for ${job.characterSlug}`);
    const dir = await mkdtemp(join(tmpdir(), 'charforge-worker-'));
    try {
      const req = await localInputs(job.request, BASE, dir);
      const outs = await perform(config, req, dir, (l) => console.error(`  ${l}`));
      const fd = new FormData();
      for (const [i, o] of outs.entries()) fd.append(`o${i}`, await openAsBlob(o.file), basename(o.file));
      const previous = req.finish && req.init ? 'previous' : undefined;
      if (previous) fd.append(previous, await openAsBlob(req.init!), basename(req.init!));
      fd.append('outputs', JSON.stringify(outs.map((o, i) => ({ field: `o${i}`, previous, seed: o.seed, meta: o.meta }))));
      const b = await api<Batch>(`/api/jobs/${job.id}/complete`, { method: 'POST', body: fd });
      console.error(`  -> batch #${b.id}`);
    } catch (e) {
      console.error(`  failed: ${(e as Error).message}`);
      await api(`/api/jobs/${job.id}/fail`, json({ error: (e as Error).message }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (values.once) return;
  }
}

async function submit(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      char: { type: 'string' }, phase: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' },
      notes: { type: 'string' }, parent: { type: 'string' }, manifest: { type: 'string' }, group: { type: 'string' },
    },
  });
  let items: ManifestItem[];
  let base = process.cwd();
  let m: Partial<Manifest> = {};
  if (values.manifest) {
    const path = resolve(values.manifest);
    m = JSON.parse(await readFile(path, 'utf8')) as Partial<Manifest>;
    base = dirname(path);
    items = m.items ?? [];
  } else {
    items = positionals.map((f) => ({ file: f, group: values.group }));
  }
  if (!items.length) throw new Error('no images: pass --manifest or image paths');
  let notes = values.notes ?? m.notes ?? '';
  if (notes.startsWith('@')) notes = await readFile(resolve(notes.slice(1)), 'utf8');

  const form = new FormData();
  const out: ManifestItem[] = [];
  for (const [i, it] of items.entries()) {
    const path = resolve(base, it.file);
    form.append(`f${i}`, await openAsBlob(path), basename(path));
    const o: ManifestItem = { ...it, file: `f${i}`, source: it.source ?? path };
    if (it.previous) {
      const prev = resolve(base, it.previous);
      form.append(`p${i}`, await openAsBlob(prev), basename(prev));
      o.previous = `p${i}`;
    }
    out.push(o);
  }
  const manifest: Manifest = {
    character: values.char ?? m.character ?? '',
    phase: values.phase ?? m.phase ?? '',
    kind: (values.kind ?? m.kind ?? 'review') as Manifest['kind'],
    title: values.title ?? m.title ?? '',
    notes,
    parentId: values.parent ? Number(values.parent) : m.parentId ?? null,
    items: out,
  };
  form.append('manifest', JSON.stringify(manifest));
  const b = await api<Batch>('/api/batches', { method: 'POST', body: form });
  console.log(`batch #${b.id} submitted: ${b.counts.total} images for ${b.characterSlug} (${b.phase}, round ${b.round})`);
  console.log(`review it at ${BASE}/review/${b.id}`);
}

function printVerdicts(v: VerdictExport) {
  const s = v.summary;
  console.log(`#${v.batch.id} ${v.batch.title} (round ${v.batch.round}) — ${v.batch.status}`);
  console.log(`${s.approved} approved, ${s.rejected} rejected, ${s.pending} pending, ${s.total} total`);
  if (v.batch.ownerNote) console.log(`\nowner note: ${v.batch.ownerNote}`);
  if (v.picks) {
    console.log('\npicks:');
    for (const [g, p] of Object.entries(v.picks)) console.log(`  ${g || '(no group)'}: ${p ? `${p.label}  ${p.source ?? ''}` : 'none (all rejected)'}`);
  }
  if (v.fixPlan.length) {
    console.log('\nfix plan:');
    for (const f of v.fixPlan) console.log(`  ${f.count}× ${f.label} [${f.code}]\n     ${f.fix}\n     in: ${f.items.join(', ')}`);
  }
  const notes = v.items.filter((i) => i.verdict === 'reject' || i.note || i.pins.length || i.regions.some((g) => g.verdict === 'bad'));
  if (notes.length) console.log('\ndetails:');
  for (const i of notes) {
    console.log(`  ${i.verdict.toUpperCase()} ${i.label}  ${i.source ?? ''}`);
    if (i.reasons.length) console.log(`    reasons: ${i.reasons.map((r) => r.label).join(', ')}`);
    for (const g of i.regions.filter((r) => r.verdict === 'bad')) console.log(`    ${g.label} [${g.box.join(',')}]: ${g.reasons.map((r) => r.label).join(', ') || 'bad'}`);
    for (const p of i.pins) console.log(`    pin [${p.box.join(',')}]: ${p.reason?.label ?? ''} ${p.note}`.trimEnd());
    if (i.note) console.log(`    note: ${i.note}`);
  }
}

async function verdicts(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const v = await api<VerdictExport>(`/api/batches/${positionals[0]}/verdicts`);
  if (values.json) console.log(JSON.stringify(v, null, 2));
  else printVerdicts(v);
}

async function wait(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { timeout: { type: 'string' }, json: { type: 'boolean' } } });
  const id = positionals[0];
  const deadline = Date.now() + Number(values.timeout ?? 86_400) * 1000;
  let last = '';
  for (;;) {
    const b = await api<Batch>(`/api/batches/${id}`);
    if (b.status === 'submitted') break;
    const line = bar(b.counts);
    if (line !== last) console.error(`waiting for the owner on #${id}: ${line}`);
    last = line;
    if (Date.now() > deadline) { console.error('timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  await verdicts(values.json ? [id, '--json'] : [id]);
}

const [cmd, ...rest] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<void>> = {
  next, status, char, profile, render: renderCmd, finish: finishCmd, submit, verdicts, wait, gate, worker,
  serve: async () => void (await import('../src/server/main.ts')),
};
const run = commands[cmd ?? ''];
if (!run) {
  console.log('usage: forge next <slug> | status | char add|brief|cover | profile | render | submit | wait <id> | verdicts <id> | gate | worker | serve\n(see the header of bin/forge.ts or AGENTS.md)');
  process.exit(cmd ? 1 : 0);
}
run(rest).catch((e: Error) => {
  console.error(`forge: ${e.message}`);
  process.exit(1);
});
