#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// forge: the agent's side of the studio. Submit images for review, wait for the owner, read the verdicts.
//
//   forge status [--char <slug>]
//   forge char add <slug> --name <name> [--summary <text>]
//   forge char cover <slug> <itemId>
//   forge submit --char <slug> --phase g5 --title "..." [--kind review|pick] [--notes <text|@file>]
//                [--parent <batchId>] (--manifest <file.json> | <image> ...)
//   forge wait <batchId> [--timeout <seconds>]
//   forge verdicts <batchId> [--json]
//   forge serve
//
// FORGE_URL (default http://127.0.0.1:8787) points at the studio.

import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Batch, CharacterDetail, Character, Manifest, ManifestItem } from '../src/shared/types.ts';
import type { VerdictExport } from '../src/server/verdicts.ts';

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

async function char(argv: string[]) {
  const [sub, slug, ...rest] = argv;
  if (sub === 'add') {
    const { values } = parseArgs({ args: rest, options: { name: { type: 'string' }, summary: { type: 'string' } } });
    const ch = await api<Character>('/api/characters', json({ slug, name: values.name ?? slug, summary: values.summary ?? '' }));
    console.log(`created ${ch.slug}`);
  } else if (sub === 'cover') {
    await api(`/api/characters/${slug}`, { ...json({ coverItemId: Number(rest[0]) }), method: 'PATCH' });
    console.log(`cover of ${slug} set to item ${rest[0]}`);
  } else {
    throw new Error('usage: forge char add <slug> --name <name> | forge char cover <slug> <itemId>');
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
  status, char, submit, verdicts, wait,
  serve: async () => void (await import('../src/server/main.ts')),
};
const run = commands[cmd ?? ''];
if (!run) {
  console.log('usage: forge status | char add|cover | submit | wait <id> | verdicts <id> [--json] | serve');
  process.exit(cmd ? 1 : 0);
}
run(rest).catch((e: Error) => {
  console.error(`forge: ${e.message}`);
  process.exit(1);
});
