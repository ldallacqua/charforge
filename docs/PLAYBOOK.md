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

1. **Order: design, then LoRA, then every asset.** Never sprites before the LoRA. The first character
   (Rin) did it the other way round and every sprite was redone.
2. **Identity anchors:** 3 to 5 strong, model-readable features (hair cut and colour, eye colour, horns,
   one signature accessory). Fine detail (a thin tiara, a small cutout) drifts until there is a LoRA.
3. **Control, not lottery:** pose and composition come from a skeleton, a sketch or an approved image
   (ControlNet or img2img), not from the seed.
4. **One base body per pose, outfits as layers** (inpaint), expressions as a face-only pass. Outfit
   changes then do not make the sprite jump.
5. **Every final image gets the finishing chain:** a hires pass (1.5x at denoise 0.4) and a face pass;
   hands get a 2x detail pass; game art gets a 2x upscale. A single 1 MP pass gives soft faces and broken
   hands, which is most of what makes images look AI-made.
6. **Clean prompts:** 15-30 tags, spaces not underscores, one framing, no repeated appearance (the LoRA
   and the character prompt already carry it). Contradicting framings produce split, two-panel images.
7. **Adults only:** adult in the brief and the card, `mature female, adult` (or male) in every prompt,
   `loli, child, underage` in every negative. A concept that reads young is rejected (`concept.young`).
8. **Full-body masters:** every pose is rendered head to feet with margin; smaller framings are crops
   of the master. The feet get reviewed like the hands.
9. **The owner reviews in the studio, after you.** Run the automatic checks and your own zoomed review
   first. Never send something an automatic check would catch.
10. **Reproducible:** every prompt, seed and parameter is in the item's `meta` (`forge render --submit`
    does it); scripts live in the repository, never only in a temp folder.

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

**Reference sheet** from the master: front, side and back full body, a face close-up, 6 expressions,
callouts of the anchors. One request per view, always with the master as reference
("same character, side view, full body, white background"). Local reference editing (Qwen-Image 2.1,
FLUX 3 Klein) or the cloud backend; img2img of the master at 0.5-0.6 as a fallback (weak for backs).

**Anchors test, always on the local model** (even when SFW is rendered in the cloud, because NSFW and
chat CGs come from the local GPU): 20 images from the appearance text only, no LoRA, no reference,
5 scenes x 4 seeds. Submit as a review batch with face and hair regions. **Passes** when each anchor
appears in at least 70 % of the 20; otherwise simplify the anchor (bigger, higher contrast) and repeat.
The owner signs off G2.

## G3: dataset

- 30-60 images, at least 1024 px on the short side of the bucket.
- Mix: ~20 % close-up, ~30 % bust and waist, ~25 % full body, ~10 % side and back, 15-25 % other outfit
  states **including nude (4-8, always local)**. Every outfit state the story needs is represented.
- Sources: reference-sheet edits (angles, poses), txt2img with the appearance text plus img2img of the
  master (~0.55) in varied scenes, other outfits. Nudity from the master: paint the outfit in skin tone
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
| data | 1024 with buckets 640-1536, repeats 8, batch 4, `keep_tokens 1` |
| length | 12 epochs, save every 2 |
| speed | bf16, sdpa, gradient checkpointing, latent cache; ~22 min, ~15 GB |

On Windows set `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` or the log crashes. Triggers: `<name>` for
the identity and `<name>_<outfit>` for the canonical outfit.

**Gate:** a pick batch, one group per test prompt, one candidate per saved epoch, same seeds:
(1) trigger + outfit, white background; (2) trigger + outfit in a scene; (3) trigger + **another**
outfit in daylight; (4) trigger + nude; (5) a couple (`1boy, faceless male`). The chosen epoch shows
the anchors in all five, keeps the canonical outfit out of prompt 3, and is not overcooked. Then add the
LoRA to the profile:

```bash
forge profile <slug> --sfw-opt 'loras=[{"name":"<name>_v1.safetensors","weight":1}]' \
                     --nsfw-opt 'loras=[{"name":"<name>_v1.safetensors","weight":1}]'
```

## G5: sprites

**Mapping.** SillyTavern classifies each reply into 28 labels (go_emotions); a missing label falls
back to `neutral`. The 28 are grouped into 6 body poses; each label is drawn once per outfit set, on
the pose that matches its body language (28 sprites per set, not 6 x 28):

| Pose | Body | Labels |
|---|---|---|
| P1 confident | hand on hip, chin up | pride, approval, optimism, amusement |
| P2 closed | arms crossed | annoyance, disapproval, anger, disgust, disappointment |
| P3 shaken | hand on cheek, other on chest | embarrassment, nervousness, surprise, realization, fear |
| P4 seductive | finger at lips, head tilted | desire, love, curiosity, admiration |
| P5 open | arms open | joy, excitement, gratitude, relief |
| P6 withdrawn | hands together, eyes down | sadness, grief, remorse, caring, confusion, neutral |

Outfit sets: the canonical outfit in `characters/<Name>/`, others in subfolders (`nude/`, `robe/`).
Two sets = 56 sprites; a third set adds 28.

**Steps:**

1. **Full-body master per pose**: 768 x 1344 base, hires to 1152 x 2016, head to feet with margin top
   (horns, accessories) and bottom (feet). Pose from an OpenPose skeleton (ControlNet) or txt2img with
   the pose tags, 6 seeds per pose, pick one (pick batch). Outpaint the top if cut.
2. **Base nude body per pose** with the LoRA, then **each outfit by inpaint** on it (mask torso and legs,
   denoise 1.0, the outfit token). Shortcut used for Rin: img2img the dressed base at 0.55, then paint
   the outfit in skin tone and img2img at 0.75.
3. **Hands at the face's resolution**: re-render each hand crop of the base at 1024 px with the LoRA,
   denoise ~0.38, 3 seeds, a nails prompt; pick at >= 400 px per hand. A hard hand pose (fingers lying
   flat, overlapping) needs denoise 0.55-0.65, a shape prompt ("palm down, four fingers together, one
   thumb"), 8 seeds, and the **whole render square** pasted back (a feathered ellipse leaves a ghost of
   the old finger).
4. **Expressions** by a face-only pass (denoise 0.55; 0.58 for eyes-down poses), one per label.
5. **Hands near the face come from the base**: the face pass redraws anything near the face and creates
   ghost fingers. Paste the approved base hand (polygon) over every expression, and restore everything
   below the chin from the base (necklaces change colour between expressions otherwise).
6. **Cutout**: render on flat white and run `tools/cutout2.py` (pockets, halo, edge colour), or use a
   backend with native transparency. Check on dark and magenta backgrounds.
7. **Display crop and normalisation**: for SillyTavern, crop the master to 832 x 1367 with face width
   F = 265 px and face top T = 316 px, figure running off the bottom edge (same scale and position for
   every sprite, or they jump). Keep the masters.
8. **Automatic QA**: `tools/qa_sprites.py <folder> --face --sheet flagged.png` must PASS; look at every
   flagged crop. Waivers (art that looks like a defect, such as a white rim light inside the line art)
   go into a waivers file with a reason and date.
9. **Your zoomed review**: `tools/qa_zoom.py` sheets, each hand >= 400 px tall on screen. Count fingers.
10. **Submit** one review batch per set or per pose, with regions: every hand, eyes, face, feet (full
    body), horns, wings and tail when visible, plus edge spots the automatic QA flagged. Same region
    label for the same body part across expressions (the studio keeps the loupe on it while the owner
    flips images, which is how inconsistent hands get caught).

Common fixes: wrong hand in the base: re-render the hand; wrong hand in one expression: paste the base
hand; pocket, halo or ghost strand: redo the cutout; face detail: repeat the face pass with another seed.

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
