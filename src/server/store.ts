// Image files on disk: data/files/<character>/<batch>/<position>-<label>.<ext>, plus a WebP thumbnail.

import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';

export interface Stored {
  file: string;
  thumb: string;
  width: number;
  height: number;
  hasAlpha: boolean;
}

const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export function safeName(s: string): string {
  return s.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
}

export async function storeImage(dataDir: string, rel: string, name: string, data: Uint8Array): Promise<Stored> {
  const ext = extname(name).toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error(`unsupported image type: ${name}`);
  const meta = await sharp(data).metadata();
  if (!meta.width || !meta.height) throw new Error(`not an image: ${name}`);
  const dir = join(dataDir, 'files', rel);
  await mkdir(dir, { recursive: true });
  const base = safeName(name.slice(0, -ext.length));
  const file = `${rel}/${base}${ext}`;
  const thumb = `${rel}/${base}.thumb.webp`;
  await writeFile(join(dataDir, 'files', file), data);
  await sharp(data).resize({ height: 360, width: 360, fit: 'inside' }).webp({ quality: 82 }).toFile(join(dataDir, 'files', thumb));
  return { file, thumb, width: meta.width, height: meta.height, hasAlpha: !!meta.hasAlpha };
}
