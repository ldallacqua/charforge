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

The studio can render on its own (the owner's "Gerar mais 4 parecidas" and "Ampliar 2×", or
`POST /api/characters/<slug>/jobs` with a `request`, or `fromItem` plus `count` or `finish`):
it queues a **job** for the backend the profile names, and a **worker** that can run that backend takes it.
The images arrive as a new batch.

- **In the server**: `CHARFORGE_WORKER_BACKENDS=comfyui,openai` makes the server run those itself
  (they only need network access and env settings).
- **On a machine with a CLI or a GPU**: `forge worker` claims jobs for every backend available there
  (`--backends codex` to restrict, `--once` to run one and exit). This is how a server in Docker uses the
  Codex CLI installed on the host.

## Resolution and transparency

| Backend | Native size | Transparency |
|---|---|---|
| comfyui (SDXL) | ~1 MP base (832 x 1216, 768 x 1344, 1152 x 896), hires 1.5x built in | none: render on flat white and run `tools/cutout2.py` (LayerDiffuse for SDXL and Qwen-Image 2.1 are native options not wired in yet) |
| openai | `gpt-image-2.5-sunburst` by default (`gpt-image-1` was shut down on 2026-10-23): the request's exact shape, divisible by 16, from 1024 x 1536 worth of pixels up to 2560 x 1440 worth (above that the API calls it experimental); other models get 1024 x 1024, 1024 x 1536 or 1536 x 1024 | `--transparent` |
| codex | ~1024 x 1536 (plan limit), ~60-100 s per image; references are attached to the run (`--image`), not only named | `--transparent` |

Full-body sprite masters: 768 x 1344 base with hires to 1152 x 2016 on comfyui, 1024 x 1536 on the cloud
backends. Neither is enough to crop from. The SillyTavern sprite has the face at F = 265 px (the anime face
detector's box); in a full-body master that box is ~230 px at 1152 x 2016 and ~175 px at 1024 x 1536, so a
crop straight from the master is enlarged ~1.15x (GPU) or ~1.5x (GPT), and the face was drawn small to
begin with. **Every approved master is finished at 2x before it is cropped or cut out**: the crop then
shrinks the master (~0.6x) and keeps the redrawn detail.

## Finishing: 2x in tiles

`forge finish` (or "Ampliar 2×" on an image in the studio) enlarges an approved picture to twice its size
by redrawing it in overlapping tiles and joining them without seams. `tools/tiles.py` cuts and joins (no
model runs there); the backend redraws every tile. The method is Siren Siege's decision D-037, which the
owner compared and approved. The join holds for four reasons:
- tiles overlap, and one extra tile is centred on the face, so the eyes come from a single redraw (that
  tile wins wherever it reaches);
- every redraw is lined up with the part it redraws (OpenCV ECC, affine);
- each tile keeps its fine detail and takes its overall colour from the approved picture, so tiles agree
  and skin and hair keep the approved colours;
- on a cut-out the outline is the redraw's, trusted only near the approved outline: it may move inwards by
  2 px at most, and the join reports `edge_loss` (outline pixels that were solid and came out see-through,
  ~0 when right; a finish above 2 % logs a warning).

| Backend | Method | Tiles | Time (Rin, measured) |
|---|---|---|---|
| codex, openai | **GPT in tiles**: each tile is sent enlarged and soft, and GPT redraws it sharp with nothing moved, transparent background on a cut-out. The owner's choice for SFW. | fewest that keep ≥ 0.8 redraw px per output px, plus the face tile (4 for an 832 x 1367 sprite: three bands and the face; 9 for a 1152 x 2016 master) | ~2-5 min, 3 tiles at a time |
| comfyui | **GPU local in tiles**: SDXL img2img with the character's checkpoint and LoRA, tiles of ~1 MP at exactly 2x, denoise 0.25, face tile at 1024 px or more with denoise 0.2, sampler `dpmpp_2m` + `karras` (not an ancestral one, which adds fresh noise at every step). The only route for NSFW. | 7 for a sprite, 16 for a master | 40-70 s |
| mock | tiles come back unchanged (tests the cut and join) | | |

- **The rating decides the route.** An image whose rating the studio does not know counts as NSFW when the
  character has NSFW, so it is finished locally. `--backend` asks for another method (to compare), and a
  cloud backend is still refused for NSFW.
- **Denoise is the eyes' enemy.** (These tests ran with the ancestral sampler that the tiles no longer use.) On Rin's sprite, a face tile at 0.4 redrew her surprised eyes
  half-closed; on a full-body master, where the face is small and SDXL has more to invent, 0.3 opened her
  smiling eyes and added a mole, and 0.2 came close (this is what "local models destroy the eyes" means).
  The face tile defaults to 0.2; put the expression in the prompt (`surprised, wide-eyed`) and never a
  negative that fights it. A finish from a studio item reuses the item's prompt. GPT in tiles kept the eyes
  in every test.
- **What GPT is sent.** Each tile is cut at the exact shape of the redraw it asks for (1024 x 1536, 1536 x
  1024 or 1024 x 1024), so nothing is stretched on the way (a stretched face comes back "corrected"). A
  cut-out is sent on the backdrop farthest from the colours along the figure's outline, of mid-grey, light
  grey and dark (Rin gets light grey), and the tile prompt names it: on a backdrop close to a part's colour,
  GPT's transparency eats into that part (on the old dark backdrop, a third of the edge of Rin's black
  horns, wings and dress came out see-through). The prompt also locks the eyes (eyelid height, iris,
  pupils, highlights), the mouth, and bans new strands, jewellery, moles, blush and rims.
- **A redraw that does not line up is never placed.** The join leaves it out and the tile is drawn again (two
  more rounds, then the job fails). Codex images are read from the run's own session folder
  (`~/.codex/generated_images/<session>/`, found by the run's working directory): in a parallel run the
  agent once copied "the newest image anywhere", which was another tile.
- **Python**: the cut and the join need Python 3.9+ with numpy, pillow and `opencv-python-headless<5`
  (OpenCV 5 dropped the face detector). `python3 -m venv tools/.venv && tools/.venv/bin/pip install numpy
  pillow "opencv-python-headless<5"`, or point `CHARFORGE_PYTHON` at one. The Docker image has it.
- **Face**: from the item's `face` region, `--face x0,y0,x1,y1`, or found by the anime face detector
  (tried on several backgrounds; a hand on the cheek can still hide it, and then there is no face tile).

```bash
pnpm forge finish --char rin --item 812                          # queue it; arrives as a batch with the item as "before"
pnpm forge finish --char rin --item 812 --backend comfyui        # the other method, to compare
pnpm forge finish --char rin --init master.png --rating sfw      # run it here, print the file
```

## Adding a backend

Implement `Backend` in `src/render/` (`allowsNsfw`, `unavailable`, `render`), register it in
`src/render/index.ts`, add it to the table above and, if it is a good default, to `PRESETS`. Keep machine
settings in the environment and character settings in `options`. Add a test with a fake server or the
`mock` backend.
