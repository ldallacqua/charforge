// The registry of rendering backends, the profile presets offered when a character is created, and the
// routing rule: a request goes to the backend the character's profile names for its rating.

import { mkdir } from 'node:fs/promises';
import { codex } from './codex.ts';
import { comfyui } from './comfyui.ts';
import { openai } from './openai.ts';
import { command, mock } from './others.ts';
import type { Backend, BackendConfig, BackendId, Log, Preset, Rating, RenderOutput, RenderProfile, RenderRequest } from './types.ts';

export * from './types.ts';

export const BACKENDS: Record<BackendId, Backend> = { comfyui, openai, codex, command, mock };

/** Offered when a character is created. Character-level options (LoRA, checkpoint) are added later. */
export const PRESETS: Preset[] = [
  {
    id: 'local',
    label: 'Tudo na GPU local',
    description: 'SFW e NSFW no ComfyUI da sua placa. Rápido, privado, um estilo só em tudo.',
    profile: { sfw: { backend: 'comfyui' }, nsfw: { backend: 'comfyui' } },
  },
  {
    id: 'hybrid-codex',
    label: 'ChatGPT para SFW, GPU para NSFW',
    description: 'O SFW sai do Codex CLI com o seu plano do ChatGPT (sem chave de API); o NSFW sai da sua placa.',
    profile: { sfw: { backend: 'codex' }, nsfw: { backend: 'comfyui' } },
  },
  {
    id: 'hybrid-api',
    label: 'API da OpenAI para SFW, GPU para NSFW',
    description: 'O SFW sai da API de imagens (cobrada por imagem, mais rápida que o CLI); o NSFW sai da sua placa.',
    profile: { sfw: { backend: 'openai' }, nsfw: { backend: 'comfyui' } },
  },
  {
    id: 'sfw-codex',
    label: 'Só SFW, pelo ChatGPT',
    description: 'Sem conteúdo NSFW e sem GPU: tudo pelo Codex CLI.',
    profile: { sfw: { backend: 'codex' }, nsfw: null },
  },
];

export function validateProfile(p: RenderProfile): string | null {
  for (const rating of ['sfw', 'nsfw'] as const) {
    const c = p[rating];
    if (!c) {
      if (rating === 'sfw') return 'the profile needs an SFW backend';
      continue;
    }
    const b = BACKENDS[c.backend];
    if (!b) return `unknown backend ${c.backend} (${Object.keys(BACKENDS).join(', ')})`;
    if (rating === 'nsfw' && !b.allowsNsfw(c.options ?? {})) return `${b.label} cannot render NSFW: use a local backend (comfyui)`;
  }
  return null;
}

export function backendFor(profile: RenderProfile, rating: Rating): BackendConfig {
  const c = profile[rating];
  if (!c) throw new Error(`this character has no ${rating.toUpperCase()} backend in its profile`);
  return c;
}

/** Render with whatever backend the config names. Throws when the backend cannot run in this environment. */
export async function render(config: BackendConfig, req: RenderRequest, outDir: string, log: Log = () => {}): Promise<RenderOutput[]> {
  const b = BACKENDS[config.backend];
  if (!b) throw new Error(`unknown backend ${config.backend}`);
  const options = config.options ?? {};
  if (req.rating === 'nsfw' && !b.allowsNsfw(options)) throw new Error(`${b.label} cannot render NSFW`);
  const why = b.unavailable(options);
  if (why) throw new Error(`${b.label} is not available here: ${why}`);
  await mkdir(outDir, { recursive: true });
  return b.render(req, options, outDir, log);
}

/** Backends that can run in this environment (for workers). */
export function availableBackends(): BackendId[] {
  return (Object.values(BACKENDS) as Backend[]).filter((b) => b.id !== 'command' && b.id !== 'mock' && !b.unavailable({})).map((b) => b.id);
}
