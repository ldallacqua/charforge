# Playbook: a character from brief to approval

The full procedure, gate by gate. Any agent (Claude, Codex, Gemini, a person) can follow it and can
**resume from any point**: the state lives in the studio, not in a conversation. Start every session with:

```bash
pnpm forge next <slug>          # what to do now, for you and for the owner
pnpm forge status --char <slug> # every batch and its counts
```

Rendering backends and profiles are in [RENDERING.md](RENDERING.md); models and licences in
[MODELS.md](MODELS.md); installing into SillyTavern in [SILLYTAVERN.md](SILLYTAVERN.md).

---

## Principles

Since Rin V2 (November 2026) the method is **one design, derived everywhere, built in layers**. The review
that led to it is in the owner's homelab (`sillytavern/docs/characters/review-v2/REVIEW.md`): every V1
sprite was a separate drawing, so six poses showed six slightly different Rins.

1. **Order: design lock, then layout, then LoRA, then every asset.** On the local route never render a
   sprite before the LoRA. With a cloud SFW backend, the SFW pose bodies come right after the layout (GPT
   edits of the master) and go into the dataset.
2. **Design for the model:** 3 to 5 strong anchors (hair cut and colour, eye colour, horns, one signature
   accessory). Ornaments big and simple, one repeated motif (Rin: the same heart-shaped ruby on the circlet
   and the choker), every accent the same colour, and every optional piece decided (earrings: yes or no).
   Fine detail drifts.
3. **Derive, never re-roll:** every pose, outfit and expression starts from the approved master or from a
   finished body, not from a fresh seed (GPT edit with the master attached, or a skeleton + LoRA locally).
4. **Layered production, flat export:** a few finished bodies per outfit; expressions are masked eyes,
   brows and mouth on the finished body; other outfits are inpainted below the chin under the same head.
   Pixels outside a part's mask stay identical to the base. One scale and one anchor for every sprite.
   Composite flat images for the target app and keep the layers (Ren'Py `layeredimage`, Live2D later).
5. **Counts are per project:** how many bodies and expressions a character gets comes from where it is
   used (SillyTavern: ~3 bodies x 16 expressions; a game: what its script calls for). Layers multiply: a
   new body later reuses every expression drawn at the same head angle.
6. **Every final image gets the finishing chain:** a hires pass (1.5x at denoise 0.4) and a face pass on
   local renders (both automatic in `forge render` on ComfyUI; judge a LoRA only on images that had them); and every approved body is **finished at 2x in tiles once** (`forge finish`,
   [RENDERING.md](RENDERING.md#finishing-2x-in-tiles)) before anything is drawn on it or cropped from it.
7. **A style bible is pasted into every request:** palette (hex per material), line, shading, light, eye
   highlights. Prompts stay clean: 15-30 tags (or a short paragraph for GPT), one framing, no repeated
   appearance. Contradicting framings produce split images.
8. **Adults only:** adult in the brief and the card, `mature female, adult` (or male) in every prompt,
   `loli, child, underage` in every negative. A concept that reads young is rejected (`concept.young`).
9. **Full-body masters on a plain mid-grey background, no floor shadow:** smaller framings are crops.
   White backgrounds leave a light rim on the cut-out. The feet get reviewed like the hands.
10. **The owner reviews in the studio, after you.** Run the automatic checks and your own zoomed review
    first. Never send something an automatic check would catch.
11. **Reproducible:** every prompt, seed and parameter is in the item's `meta` (`forge render --submit`
    does it); scripts live with the character's files, never only in a temp folder.

---

## How work moves

```
forge render ... --submit  ─►  batch (open)  ─►  owner reviews  ─►  batch (submitted)
        ▲                                                                 │
        └──────── fix only the rejected items, --parent <id> ◄── forge verdicts <id> --json
```

- **Review batches**: every image approved or rejected, with reasons, region marks and pins.
- **Pick batches** (`--kind pick`): candidates for one decision (seeds of a hand, LoRA epochs); one
  `group` per decision, the owner picks one per group.
- **Rounds**: a fix is a new batch with `--parent <previous id>` and each item's `previous` image, so the
  owner compares before and after (key C in the studio).
- **Reasons** carry the fix: `fixPlan` in the verdicts lists them by frequency with the recipe
  (`src/shared/taxonomy.ts`). Approvals carry reasons too (`ok.reference`, and in discovery `like.*`).
- **Gates are signed off explicitly**: by the owner on the character page, or by you with
  `forge gate <slug> <gate> done --note "..."` once the owner said so in conversation.

---

## G0: brief, age and licences

1. **Brief**, in the owner's words: who the character is, look, personality, where it will be used
   (SillyTavern, a game), which outfit states the story needs (casual, formal, nude...). Save it:
   `forge char brief <slug> @brief.md` (the "Novo personagem" page does it).
2. **Adult**: confirmed by the owner (checkbox on creation, or ask).
3. **Render profile**: which backend renders SFW and which renders NSFW (presets in
   [RENDERING.md](RENDERING.md#presets)). NSFW only ever goes to a local backend.
4. **Licences**: every model in the profile allows the intended use ([MODELS.md](MODELS.md)).

Signed off on creation when the owner ticks "adulto" and picks a profile.

## G1: card and lorebook

For SillyTavern (adapt for other apps):

- `description` in English, in blocks: `[Appearance]` (only what is visible, with the anchors),
  `[Signature attire]`, `[History]` (3-4 sentences), `[Personality]`, `[Speech]`.
- **World, places, factions and rules go into a lorebook** (World Info) with keys, linked to the card
  (`extensions.world`) and embedded as `character_book` so the card stays portable. Entries only enter
  the prompt when the chat mentions them.
- `first_mes` with tension and a choice; at least 2 `alternate_greetings`; `mes_example` showing the
  voice; a short `depth_prompt` (depth 4) with what the model forgets (tail, wing and eye reactions, the
  main rule).
- Avatar 2:3, face in the top third. `creator_notes` say where sprites, backgrounds and tags are.

**Gate:** a 10-message test chat. The character sounds like itself, remembers its main rule, and knows
a lorebook place when it is mentioned. Show the owner the excerpt, delete the test chat, then
`forge gate <slug> g1 done`. G1 can run in parallel with G2.

## G2: design (discovery and anchors)

Discovery is a conversation in images. The owner reacts; you converge.

**Round 1, exploration (8-12 concepts).** From the brief, write genuinely different concepts, varying
one or two axes each: silhouette (proportions, hair mass, horns, sleeves), outfit, palette, mood.
Same prompt skeleton for all, so the differences are the ideas, not noise:

```
<style words>, 1girl, solo, mature female, adult, full body, standing, front view, simple background,
<hair>, <eyes>, <distinctive feature>, <outfit>, <palette words>, <mood/expression>
```

Render with the **SFW backend**, full body, plain background, then submit as one review batch:

```bash
forge render --char <slug> --rating sfw --prompt @concept-03.txt --size 768x1344 \
  --submit --phase g2 --title "Conceitos, rodada 1" --group "Rodada 1"
```

(or render all concepts first and submit one manifest). In discovery the owner answers **Gostei / Não
gostei** and says what they liked: `like.face`, `like.hair`, `like.outfit`, `like.palette`,
`like.silhouette`, `like.accessories`, `like.vibe`, `like.style`, plus notes.

**Round 2, combination (4-6).** Build each new concept from the liked parts ("hair of #3, outfit of #7,
palette of #2"), using the liked images as references (`--ref`, `--init` with denoise 0.5-0.6 on
diffusion backends). Say in the batch notes which parts came from where.

**Round 3, convergence (3-4 variations of one design).** Small changes only. Then a **pick batch** for
the master image. Apply the finishing chain to the master.

**Design lock** (after the master pick), signed off as one gate:
- **Finish the master** at 2x (`forge finish`).
- **Reference sheet**: front, side and back full body, a face close-up. One request per view, always with
  the master attached ("same character, side view, full body, mid-grey background").
- **Ornament detail sheet**: each piece large, one per image, the master attached: circlet front and
  side, the gem, horns from the side, tail tip, wing claw, sleeve cuff, shoes, a hand with the nails.
- **Style bible** (one page in the character's folder): the palette sampled from the finished master
  (k-means, then frozen as hex per material: hair base, shadow and highlight, iris, skin, dress, trim,
  gem, gold, horns, wings, nails), line colour and weight, shading ("two-tone cel, one soft gradient, no
  gloss bands"), key light direction, rim light (thin and coloured, inside the line art, or none), eye
  highlights. Its prompt block goes first in every later request.

**Anchors test, always on the local model** (NSFW and chat CGs come from the local GPU): 20 images from
the appearance text only, no LoRA, no reference, 5 scenes x 4 seeds, plus 4 ornament close-ups. Submit
as a review batch with face, hair and ornament regions. **Passes** when each anchor appears in at least
70 % of the 20; otherwise simplify the anchor (bigger, higher contrast) and repeat.
With a cloud SFW backend, expect the local images to differ a lot from the cloud design (skin tone,
ornaments, outfit details, rendering): text alone cannot carry a design drawn by another model. The test
is not art to approve; it measures what the base model gets on its own, and that gap is what the LoRA
closes (G4 tests parity), while the sprites share the cloud pixels by construction (G5 steps 5-6). Tell
the owner so in the batch notes. Rin V2: the owner found the local images "very different" from GPT's.

## G2.5: layout (bodies, expressions, canvas)

Decided before the dataset, so the dataset can contain the real sprite bodies and heads.

- **Canvas template**: one scale for the character, from the master (crown-to-chin height), and one
  anchor (the neck point at a fixed x, the figure running off the bottom edge). Every body is drawn on it;
  QA checks `|s_pose / s_master - 1| < 0.02`.
- **Bodies** (how many: principle 5). Choose poses where every hand either reads in silhouette against a
  contrasting value or is hidden (behind the hip, tucked under crossed arms); no fingers lying on skin of
  the same colour; no hand within one face-width of the face (every expression pass would redraw it).
  One head angle per body, looking at the viewer.
- **Expression sheet**: every expression drawn on the master's head at each body's head angle, as masked
  edits of eyes, brows and mouth only. The owner names each face unlabelled at sprite size; two faces that
  get confused twice merge. Blush only where the label asks for it.
- **For SillyTavern**, 16 expressions on 3 bodies as custom expressions (the classifier then only picks
  labels that exist: Expressions settings, "only available"): neutral, smug, happy, laughing, teasing,
  seductive, tender, curious (signature body); annoyed, angry, disgusted (closed body); flustered,
  surprised, scared, sad, crying (shaken body). If the 28 go_emotions labels are needed (local
  classifier), copy files under those names: pride and approval = smug; optimism and joy = happy;
  amusement and excitement = laughing; desire = seductive; love, caring, gratitude, relief and admiration =
  tender; curiosity, confusion and realization = curious; annoyance, disapproval and disappointment =
  annoyed; embarrassment and nervousness = flustered; fear = scared; sadness and remorse = sad; grief =
  crying. Each expression may get a blink frame (animated WebP or APNG; SillyTavern accepts any image).

Submit the bodies as a pick batch and the expression sheet as a review batch. The owner then signs off
G2 (design and layout together: `forge gate <slug> g2 done`).

## G3: dataset

- 30-60 images, at least 1024 px on the short side of the bucket.
- Mix: ~20 % close-up, ~30 % bust and waist, ~25 % full body, ~10 % side and back, 15-25 % other outfit
  states **including nude (4-8, always local)**. Every outfit state the story needs is represented.
- Sources: the design lock and the layout (turnaround, ornament close-ups captioned
  `<trigger>, close-up, <part>`, the sprite bodies, the expression heads), edits of the master in varied
  scenes, other outfits. Not txt2img from the appearance text alone: the LoRA then learns an average of
  the ornaments. Nudity from the master: paint the outfit in skin tone
  and img2img at 0.75, or inpaint the body (mask the outfit, denoise 1.0, `completely nude`).
- With a cloud SFW backend, do two rounds: (1) SFW from the cloud, train LoRA v1 (+ a project style LoRA
  on all approved cloud images so local renders look like them); (2) nudity locally with LoRA v1 + style
  LoRA by inpainting approved cloud images; LoRA v2 = both. v2 goes to production.
- Every image gets the finishing chain (a blurry dataset teaches blur).
- Captions: `<trigger>, 1girl, solo, [<outfit token>,] <scene and pose>`, without the tags the
  triggers absorb (hair, eyes, pieces of the canonical outfit).

Submit by outfit state (one batch each), face and hand regions on every image. Zero wrong anchors,
zero broken hands, zero near-duplicates.

## G4: LoRA

kohya `sd-scripts` on the GPU machine. Stop ComfyUI while training. Parameters that worked (SDXL /
Illustrious, RTX 4090):

| Parameter | Value |
|---|---|
| network | `networks.lora`, dim 32, alpha 16 |
| learning rate | UNet 1.5e-4, text encoder 3e-5 |
| optimizer, scheduler | AdamW8bit, cosine, warmup 40, `min_snr_gamma 5` |
| data | 1024 with buckets 640-1536, repeats 6-8 (~1000 steps), batch 4, `keep_tokens 2` (trigger, outfit) |
| length | 12 epochs, save every 2 |
| speed | bf16, sdpa, gradient checkpointing, latent cache; ~22 min, ~15 GB |

On Windows set `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` or the log crashes. Triggers: `<name>` for
the identity and `<name>_<outfit>` for the canonical outfit.

**Gate:** a pick batch, one group per test prompt, one candidate per saved epoch, same seeds:
(1) trigger + outfit, white background; (2) trigger + outfit in a scene; (3) trigger + **another**
outfit in daylight; (4) trigger + nude; (5) a couple (`1boy, faceless male`); (6) an ornament close-up (`<trigger>, close-up,
<signature accessory>`). With a cloud SFW backend add (7) **parity**: the master's
pose and framing on mid-grey, rendered locally with the LoRA, shown next to the approved cloud master in
the same group; the owner judges skin tone, ornaments, outfit and rendering against it. If the local look
still differs, train a style LoRA on the approved cloud images (G3) before going on. The chosen epoch shows
the anchors in all five, keeps the canonical outfit out of prompt 3, and is not overcooked. Then add the
LoRA to the profile:

```bash
forge profile <slug> --sfw-opt 'loras=[{"name":"<name>_v1.safetensors","weight":1}]' \
                     --nsfw-opt 'loras=[{"name":"<name>_v1.safetensors","weight":1}]'
```

## G5: sprites

Built in layers from the G2.5 layout. Outfit sets for SillyTavern: the canonical outfit in
`characters/<Name>/`, others in subfolders (`nude/`, `robe/`).

1. **Bodies, derived from the master**, on the canvas template, wings folded: SFW by GPT edit with the
   master attached ("same character, same outfit, change only the pose to ..."); locally by an OpenPose
   skeleton drawn on the template + the LoRA, then img2img/inpaint at the master's scale. A few
   candidates per body, one pick batch.
2. **Hands, once per body**: masked inpaint of the hand (polygon dilated 10-12 px), 2x context crop,
   ControlNet depth or canny from the approved hand at ~0.5, denoise ~0.45, 3-8 seeds, a nails prompt from
   the style bible; pick at >= 400 px per hand. Never paste a square that contains jewellery.
3. **Finish each body at 2x once** (`forge finish`): GPT in tiles for SFW, GPU local in tiles for NSFW.
   Compare with the unfinished body (key C) at 3x: eyes, fingers, outline, skin colour.
4. **Cut out each body once**: GPT renders with native transparency; local renders on mid-grey and
   `tools/cutout2.py`. Check on dark and magenta backgrounds; QA's rim check must pass.
5. **Expressions on the finished body**: draw two masks once per body (eyes + brows with a few px of lid
   shadow; mouth with the chin crease; blush optional). Each expression is an edit inside those masks
   only: GPT masked edit for SFW ("edit only the eyes, eyebrows and mouth to show ...; everything else is
   locked", the irises keep the style bible colour), or a local masked inpaint (InpaintModelConditioning +
   DifferentialDiffusion, denoise 0.6-0.75, `dpmpp_2m` + `karras`, 24 steps, a 2x face context crop).
   QA: the largest difference outside the masks is 0.
6. **Other outfits below the chin**: on the finished dressed body, inpaint locally inside the outfit mask
   (denoise 1.0, DifferentialDiffusion at the edge); the head, horns, wings and the expression layers are
   the same pixels in every set, so the head GPT finished on the SFW body is reused without any NSFW image
   leaving the GPU. Check the neck seam at 3x.
7. **Composite** body x expression x outfit into flat images; keep the layers.
8. **Display crop** with the one global scale: for SillyTavern 832 x 1367, face width F = 265 px, face top
   T = 316 px, anchored on the neck, figure running off the bottom edge. The crop must shrink the
   finished body, never enlarge it.
9. **Automatic QA**: `tools/qa_sprites.py <folder> --face --sheet flagged.png` must PASS (halo, rim,
   pockets); look at every flagged crop. Waivers go into a waivers file with a reason, a date and a
   zoomed crop.
10. **Your zoomed review**: `tools/qa_zoom.py` sheets, each hand >= 400 px tall on screen. Count fingers.
11. **Submit** one review batch per body or set, with regions: every hand, eyes, face, feet, horns, wings,
    tail and the signature ornaments (circlet, choker gem). Same region label for the same part across
    sprites, so the studio keeps the loupe on it while the owner flips images.

Tooling status (November 2026): `forge render` does txt2img and img2img, `forge finish` the 2x step.
Masked inpaint, OpenPose and depth ControlNet run through a ComfyUI workflow file (`workflow` option with
`%init%`; ComfyUI 0.46 has the nodes built in, only the model files are needed) or a script in the
character's folder, until Charforge wraps them.

## G6: backgrounds and CGs

- **Backgrounds**: one per recurring lorebook place, 1216 x 832 + hires, **no people**, centre free and
  darker, same palette. SillyTavern name: `<Realm> - <Place>.jpg`.
- **Couples in POV**: `1boy, hetero, pov, pov hands` (only his hands). Two full bodies in one landscape
  image duplicate the couple and put wings and tails on the wrong body (2 of 3 in the A/B test; POV 3 of
  3 coherent). When both must be whole: one framing, `split screen, diptych, 2koma` in the negative,
  or a two-person skeleton / regional prompt.
- Winged characters: `folded wings` by default; open wings only when the scene is about them.
- **Showcase CGs** (opening, gallery, game): render 10-20, pick 1, face and hand pass, upscale for games.
  Submit with hand, face, wing and tail regions; review at 100 %.
- Chat CGs generated automatically are not reviewed one by one: their quality comes from the generator
  rules (hires, clean tags, POV); G7 checks a sample.

## G7: integration

Install everything in the target app ([SILLYTAVERN.md](SILLYTAVERN.md)) and run, in a test chat that is
deleted at the end:

1. Neutral chat: the expression changes **once**, when the reply ends; no CG.
2. Go to another lorebook place: the background changes.
3. A key moment: the CG appears full screen and the sprite hides; in a two-person moment the CG is POV;
   wings and tail are on her at 100 %.
4. Undress: the sprite switches to the nude set, outfit tags leave the image prompt, a coherent CG.
5. Dress again: everything returns.
6. Open the main chat: the state is recomputed (not inherited from the test chat).

Show the owner the end state of each step, then `forge gate <slug> g7 done`.

## G8: approval

The owner sees the contact sheets, the LoRA grid and 3 CGs and signs off on the character page. Before
that: backups of every installed asset, scripts and workflows in the repository, docs current.

---

## Lessons from the first character

1. LoRA before sprites; test the anchors before anything else.
2. Put nudity and every outfit state in the dataset, or later sets need tricks.
3. Poses from a skeleton, not from seed lottery.
4. Images made by a chat extension looked worse than hand-made ones for three reasons: a single 1 MP
   pass (fixed by hires), an LLM tag soup of ~60 underscore tags with contradicting framings (fixed by
   clean-tag rules), and no face pass in wide shots.
5. Markers inside the roleplay model's reply are unreliable: classify state with a separate call.
6. Long lore belongs in a lorebook.
7. Every defect the owner found only showed when zoomed: extra and ghost fingers, a white pocket between
   hair and hand, a light rim on a shoulder. Review at >= 400 px per hand; a review at ~260 px missed a
   hand with three stacked nails.
8. The face pass redraws what is near the face, including hands and jewellery: take them from the base.
9. Segmenters fail on trapped background and edges; with a known flat background, both can be solved
   exactly. Native transparency is better still.
10. Couples in POV.
11. (V2 review) Six poses rendered from six seeds were six versions of the character: horns, circlet,
    pendant, earrings, sleeves and body scale all drifted. Derive from one master and build in layers.
12. Normalising each pose by its own detected face width made the body jump up to 27 % between poses:
    use one scale for the character.
13. Rendering the nude set again changed the head: inpaint below the chin instead.
14. Ornaments asked in the same prompt as the eye colour picked it up (Rin's ruby came out green): keep
    colours next to their objects and repeat one accent colour.
15. All seven of the owner's rejections in V1 were hands: choose poses that keep hands readable or hidden.
