// Rendering backends are interchangeable: each character has a profile that says which backend renders
// its SFW images and which renders its NSFW images (or that it has none). Agents and workers call
// `render()` the same way whatever the backend is.

export type Rating = 'sfw' | 'nsfw';
export type BackendId = 'comfyui' | 'openai' | 'codex' | 'command' | 'mock';

export interface BackendConfig {
  backend: BackendId;
  /** character-level settings (checkpoint, LoRA, model, quality...). Machine settings come from env. */
  options?: Record<string, unknown>;
}

export interface RenderProfile {
  sfw: BackendConfig;
  /** null: this character has no NSFW content */
  nsfw: BackendConfig | null;
}

export interface RenderRequest {
  prompt: string;
  negative?: string;
  rating: Rating;
  width?: number;
  height?: number;
  count?: number;
  seed?: number;
  /** a transparent background where the backend supports it (openai, codex); others render on flat white */
  transparent?: boolean;
  /** image to start from (img2img / edit) */
  init?: string;
  /** img2img strength for diffusion backends (0..1) */
  denoise?: number;
  /** reference images (identity, style) for backends that take them */
  references?: string[];
  /** per-request backend overrides (steps, cfg, loras, quality...) */
  options?: Record<string, unknown>;
}

export interface RenderOutput {
  file: string;
  width: number;
  height: number;
  seed?: number;
  backend: BackendId;
  meta: Record<string, unknown>;
}

export type Log = (line: string) => void;

export interface Preset {
  id: string;
  label: string;
  description: string;
  profile: RenderProfile;
}

export interface Backend {
  id: BackendId;
  label: string;
  /** whether this backend may render NSFW with these options (cloud services never do) */
  allowsNsfw(options: Record<string, unknown>): boolean;
  /** why it cannot run here (missing URL, key, binary), or null when it can */
  unavailable(options: Record<string, unknown>): string | null;
  render(req: RenderRequest, options: Record<string, unknown>, outDir: string, log: Log): Promise<RenderOutput[]>;
}
