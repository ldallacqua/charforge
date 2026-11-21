// Jobs can point at images the studio stores (`/files/...`) or at URLs. A worker needs local files, so
// these are copied into its temp folder first: straight from disk when the worker is the server itself
// (`source` is the data directory), or downloaded from the studio (`source` is its base URL).

import { copyFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RenderRequest } from './types.ts';

async function one(ref: string, source: string, dir: string, i: number): Promise<string> {
  const name = `${i}-${basename(decodeURIComponent(ref.split('?')[0]))}`;
  const dest = join(dir, name);
  if (/^https?:\/\//.test(ref) || (ref.startsWith('/files/') && /^https?:\/\//.test(source))) {
    const url = ref.startsWith('/') ? source.replace(/\/$/, '') + ref : ref;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
    await writeFile(dest, new Uint8Array(await res.arrayBuffer()));
    return dest;
  }
  if (ref.startsWith('/files/')) {
    await copyFile(join(source, 'files', ...ref.slice('/files/'.length).split('/').map(decodeURIComponent)), dest);
    return dest;
  }
  return ref; // already a local path
}

export async function localInputs(req: RenderRequest, source: string, dir: string): Promise<RenderRequest> {
  let i = 0;
  return {
    ...req,
    init: req.init ? await one(req.init, source, dir, i++) : undefined,
    mask: req.mask ? await one(req.mask, source, dir, i++) : undefined,
    references: req.references ? await Promise.all(req.references.map((r) => one(r, source, dir, i++))) : undefined,
  };
}
