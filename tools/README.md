# tools

Python helpers the agent runs **before** submitting a batch (the owner is the second pair of eyes,
never the first), and the cut and join of the 2x finishing step. Install with
`python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt` (the studio finds
that venv by itself). OpenCV stays below 5: 5.x dropped `CascadeClassifier`, the face detector.

| Tool | Gate | What it does |
|---|---|---|
| `qa_sprites.py <folder> [--face] [--face-box x0,y0,x1,y1] [--sheet out.png] [--accept waivers.json]` | G5 | automatic sprite checks: all 28 expression labels, same canvas, real alpha, nothing cut at the top, halo below 2 %, background pockets; `--sheet` writes zoomed crops of every flagged spot |
| `qa_zoom.py <folder> <boxes.json> <out_dir>` | G5 | zoom sheets per pose: one row per expression, one column per region (face, each hand), on dark with a magenta strip |
| `tiles.py cut <picture> <work> --mode gpt\|sd [--scale 2] [--face x,y,w,h]` and `tiles.py join <picture> <work> <out.png>` | G5 | the 2x finishing step's cut (overlapping tiles plus a face tile, sized for GPT or SDXL) and seamless join (ECC alignment, colour tied to the picture, outline kept near the approved one, redraws that do not line up left out). Called by `forge finish`; see docs/RENDERING.md |
| `cutout2.py <in_dir> <out_dir> [model] [--face-box x,y,w,h]` | G5 | background removal for figures rendered on a flat, known background: BiRefNet mask, then pockets removed, edge alpha solved against the known colour (no light halo), edge colour taken from the figure |

`lbpcascade_animeface.xml` is the anime face detector by nagadomi
([lbpcascade_animeface](https://github.com/nagadomi/lbpcascade_animeface), MIT licence), used by `--face` and by `tiles.py` to centre the face tile.

When a backend can render transparency natively (OpenAI, the Codex CLI), skip `cutout2.py`.
