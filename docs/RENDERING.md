# Rendering

Backends are interchangeable. Each character has a **render profile** that names the backend for its
SFW images and the backend for its NSFW images (or none). Agents call `forge render --rating sfw|nsfw`
and never pick the backend themselves; switching a character from the cloud to the local GPU is one
command and nothing else changes.

## Backends

| id | What | SFW | NSFW | Machine settings (env) | Character settings (profile `options`) |
|---|---|---|---|---|---|
| `comfyui` | a local GPU through ComfyUI's HTTP API | yes | yes | `COMFYUI_URL` | `checkpoint`, `loras` `[{name, weight}]`, `quality`, `negativeBase`, `steps`, `cfg`, `sampler`, `scheduler`, `clipSkip`, `hires` `{scale, denoise, steps}` or `false`, `workflow` (API-format JSON with `%prompt%` `%negative%` `%seed%` `%width%` `%height%` `%init%` `%denoise%`) |
| `openai` | OpenAI Images API (GPT Image) | yes | **no** | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_IMAGE_MODEL` | `model`, `quality`, `size` |
| `codex` | the owner's Codex CLI logged in with a ChatGPT plan: no API key, uses the plan's built-in image tool | yes | **no** | `CODEX_BIN` (else PATH, else the ChatGPT app on macOS) | `bin`, `timeoutSec` |
| `command` | any other local command that writes PNGs | yes | only with `nsfw: true` | — | `command` (argv with `{prompt_file}` `{negative}` `{out_dir}` `{width}` `{height}` `{count}` `{seed}`), `nsfw` |
| `mock` | placeholder images for tests | yes | yes | — | — |

**NSFW never goes to a cloud service.** The studio refuses a profile whose NSFW backend cannot render
NSFW, and `render()` refuses an NSFW request on such a backend. `command` with `nsfw: true` is the owner's
declaration that the command runs a local model.

Secrets (API keys) live only in the environment of the machine that renders. They are never stored in
a profile, a batch or the database.

## Presets

Offered on the "Novo personagem" page and by `forge profile <slug> --preset <id>`:

| id | SFW | NSFW | When |
|---|---|---|---|
| `local` | comfyui | comfyui | everything private and fast, one style for every asset (the default for SillyTavern characters, whose chat CGs come from the GPU anyway) |
| `hybrid-codex` | codex | comfyui | showcase SFW from the ChatGPT plan, NSFW local (how Siren Siege's art was made) |
| `hybrid-api` | openai | comfyui | the same with the paid API: faster than the CLI, billed per image |
| `sfw-codex` | codex | none | no NSFW, no GPU |

Change one side or add character settings:

```bash
forge profile rin --nsfw comfyui --nsfw-opt 'loras=[{"name":"rin_v1.safetensors","weight":1}]'
forge profile lyra --sfw openai --sfw-opt quality=high
```

With a cloud SFW backend, the local model still has to carry the design (G2 anchors test) and a style
LoRA trained on the approved cloud images keeps SFW and NSFW looking alike (PLAYBOOK G3).

## Rendering from the agent

```bash
forge render --char <slug> --rating sfw --prompt @prompt.txt [--negative "..."] [--n 4] [--size 768x1344] \
  [--seed 42] [--init base.png --denoise 0.5] [--ref master.png]... [--transparent] [--opt steps=32]... \
  [--out renders/x] [--submit --phase g2 --title "..." [--group ...] [--kind review|pick]]
```

- Without `--submit` it prints the files (and writes `render.json` with the request and outputs) so you
  can curate before submitting.
- With `--submit` every image becomes an item whose `meta.request` holds the exact request and seed.
  That is what lets the owner press "Gerar mais 4 parecidas" in the studio.
- `--backend <id>` overrides the profile (tests, one-off tools).

## Jobs and workers

The studio can render on its own (the owner's "Gerar mais 4 parecidas", or `POST /api/characters/<slug>/jobs`):
it queues a **job** for the backend the profile names, and a **worker** that can run that backend takes it.
The images arrive as a new batch.

- **In the server**: `CHARFORGE_WORKER_BACKENDS=comfyui,openai` makes the server run those itself
  (they only need network access and env settings).
- **On a machine with a CLI or a GPU**: `forge worker` claims jobs for every backend available there
  (`--backends codex` to restrict, `--once` to run one and exit). This is how a server in Docker uses the
  Codex CLI installed on the host.

## Resolution and transparency

| Backend | Native size | High resolution | Transparency |
|---|---|---|---|
| comfyui (SDXL) | ~1 MP base (832 x 1216, 768 x 1344, 1152 x 896), hires 1.5x built in | upscale 2x locally (UltimateSDUpscale + low-denoise tiles) | none: render on flat white and run `tools/cutout2.py` (LayerDiffuse for SDXL and Qwen-Image 2.1 are native options not wired in yet) |
| openai | 1024 x 1024, 1024 x 1536, 1536 x 1024 (larger on newer models) | upscale locally; or render 4 overlapping tiles with the full image as reference and blend | `--transparent` |
| codex | ~1024 x 1536 (plan limit), ~60-100 s per image, one at a time | as openai | `--transparent` |

Full-body sprite masters: 768 x 1344 base, hires to 1152 x 2016 on comfyui; 1024 x 1536 on the cloud
backends, then upscale.

## Adding a backend

Implement `Backend` in `src/render/` (`allowsNsfw`, `unavailable`, `render`), register it in
`src/render/index.ts`, add it to the table above and, if it is a good default, to `PRESETS`. Keep machine
settings in the environment and character settings in `options`. Add a test with a fake server or the
`mock` backend.
