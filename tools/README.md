# tools

Python helpers the agent runs **before** submitting a batch (the owner is the second pair of eyes,
never the first). Install with `python -m venv .venv && .venv/bin/pip install -r tools/requirements.txt`.

| Tool | Gate | What it does |
|---|---|---|
| `qa_sprites.py <folder> [--face] [--face-box x0,y0,x1,y1] [--sheet out.png] [--accept waivers.json]` | G5 | automatic sprite checks: all 28 expression labels, same canvas, real alpha, nothing cut at the top, halo below 2 %, background pockets; `--sheet` writes zoomed crops of every flagged spot |
| `qa_zoom.py <folder> <boxes.json> <out_dir>` | G5 | zoom sheets per pose: one row per expression, one column per region (face, each hand), on dark with a magenta strip |
| `cutout2.py <in_dir> <out_dir> [model] [--face-box x,y,w,h]` | G5 | background removal for figures rendered on a flat, known background: BiRefNet mask, then pockets removed, edge alpha solved against the known colour (no light halo), edge colour taken from the figure |

`lbpcascade_animeface.xml` is the anime face detector by nagadomi
([lbpcascade_animeface](https://github.com/nagadomi/lbpcascade_animeface), MIT licence), used by `--face`.

When a backend can render transparency natively (OpenAI, the Codex CLI), skip `cutout2.py`.
