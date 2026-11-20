# AGENTS.md: start here

This file is the single source of truth for any AI agent (Claude Code, Codex, Gemini, Cursor, Copilot,
Aider...) working with Charforge. Tool-specific files (`CLAUDE.md`, `GEMINI.md`,
`.github/copilot-instructions.md`) only point here.

## What this is

Charforge builds characters (art + card) for SillyTavern and games with an AI agent doing the work and
the owner reviewing every image. The agent renders through interchangeable backends (local GPU via
ComfyUI, OpenAI API, the owner's Codex CLI), submits batches to the studio, waits for the owner's
verdicts, and fixes exactly what was rejected. The process is a sequence of gates, G0 to G8.

- Owner-facing overview (Portuguese): [README.md](README.md)
- The full procedure, gate by gate: [docs/PLAYBOOK.md](docs/PLAYBOOK.md)
- Backends, profiles, workers: [docs/RENDERING.md](docs/RENDERING.md)
- Models and licences: [docs/MODELS.md](docs/MODELS.md) · SillyTavern install: [docs/SILLYTAVERN.md](docs/SILLYTAVERN.md)
- Python QA and cutout tools: [tools/README.md](tools/README.md)

## Resume from any point

There is no hidden state in a conversation. The studio holds the brief, the render profile, every batch,
every verdict and every gate. To pick up work (yours or another agent's):

```bash
pnpm forge status                 # characters and batches waiting for the owner
pnpm forge next <slug>            # the next step for you and for the owner (add --json to parse)
```

Then do what `next` says. It prioritises: renders in flight, batches waiting for the owner, rejections to
fix, then the first gate not signed off. Read the relevant PLAYBOOK section before acting.

## Setup

```bash
pnpm install && pnpm build
pnpm start                        # studio on http://127.0.0.1:8787 (FORGE_URL for the CLI if elsewhere)
```

Rendering needs, on the machine that renders: `COMFYUI_URL` (local GPU), `OPENAI_API_KEY` (API), or the
Codex CLI logged in (found automatically). Check with `pnpm forge worker --once` or a test render with
`--backend mock`. Python tools: `python -m venv .venv && .venv/bin/pip install -r tools/requirements.txt`.

## The loop

1. `forge next <slug>` → the gate and the task.
2. Render with the character's profile: `forge render --char <slug> --rating sfw|nsfw ...`. Never choose
   a backend by hand for real work; the profile decides (owner's choice at creation).
3. Check automatically (`tools/qa_sprites.py` for sprites), then review yourself at counting scale (each
   hand >= 400 px). The owner is the second pair of eyes, never the first.
4. Submit (`forge render ... --submit` or `forge submit --manifest`), with regions on every hand, the eyes,
   the face, the feet (full body), and horns, wings, tail when visible. Batch notes in Portuguese: what
   changed and what to look at.
5. `forge wait <id>` in the background; when it returns, `forge verdicts <id> --json`.
6. Start from `fixPlan` (reasons by frequency, each with its `fix`). Use `regions[].box` and `pins[].box`
   (image pixels) for where. Fix only rejected items; resubmit with `--parent <id>` and each item's
   `previous`. Approved items are locked.
7. Pick batches: install exactly what `picks` says. `null` = all rejected: read their reasons, new round.
8. When a gate has nothing pending, the owner signs it off on the character page (or you run
   `forge gate <slug> <gate> done --note "..."` after the owner said so). Text gates (G0, G1, G7, G8)
   have no batches: show the owner the result in conversation, then sign off.

## Commands

```
forge next <slug> [--json]
forge status [--char <slug>]
forge char add <slug> --name <name> [--brief <text|@file>] [--preset <id>] [--adult]
forge char brief <slug> <text|@file>          forge char cover <slug> <itemId>
forge profile <slug> [--preset <id>] [--sfw <backend>] [--nsfw <backend|none>] [--sfw-opt k=v]... [--nsfw-opt k=v]...
forge render --char <slug> --rating sfw|nsfw --prompt <text|@file> [--negative ...] [--n N] [--size WxH] [--seed N]
             [--init img --denoise 0.5] [--ref img]... [--transparent] [--opt k=v]... [--out dir]
             [--submit --phase gN --title "..." [--group ...] [--kind review|pick]]
forge submit (--manifest file.json | --char <slug> --phase gN --title "..." <images>...) [--kind pick] [--parent <id>]
forge wait <batchId> [--timeout s] [--json]   forge verdicts <batchId> [--json]
forge gate <slug> <g0..g8> done|open [--note ...]
forge worker [--backends codex,comfyui] [--once]
```

## Manifest (forge submit)

```json
{
  "character": "rin", "phase": "g5", "kind": "review",
  "title": "Sprites v6: mãos refeitas", "notes": "O que mudou e onde olhar.", "parentId": 12,
  "items": [{
    "file": "out/joy.png", "previous": "old/joy.png", "label": "joy", "group": "Vestida, P5 braços abertos",
    "meta": { "set": "gown", "pose": "P5", "expression": "joy" },
    "regions": [
      { "kind": "hand", "label": "Mão esquerda", "box": [0, 520, 200, 760] },
      { "kind": "eyes", "label": "Olhos", "box": [335, 370, 555, 475] }
    ],
    "checks": [{ "name": "qa_sprites", "status": "pass", "detail": "halo 0.21%" }]
  }]
}
```

Paths are relative to the manifest. Region kinds: `face eyes mouth hair horns hand feet body outfit
accessory wings tail edge other`. Phases `g0`-`g8`. Check status `pass warn fail info`. Kinds `review`
(approve/reject each) and `pick` (one per `group`). In G2 (discovery) approvals mean "liked" and carry
`like.*` reasons.

## Rules

- **Adults only.** Adult in the brief and card, `mature female, adult` in prompts, `loli, child, underage`
  in negatives. Reject your own output if it reads young.
- **NSFW only on local backends.** Never send NSFW prompts to OpenAI or the Codex CLI; the profile
  enforces it, do not work around it.
- **Secrets** (API keys) only in the environment of the rendering machine. Never in profiles, manifests,
  notes, commits or the UI.
- **Never commit `data/`** (images, some NSFW, and the database) or renders.
- **Full-body masters** for sprites; display crops come from the master. Feet get a region.
- **Reason codes** (`src/shared/taxonomy.ts`) are stored and read by agents: add codes, never rename or
  remove. Labels Portuguese (owner), `fix` English (agents).
- **Language:** UI copy and batch notes in Portuguese (pt-BR, sentence case, plain verbs); code, comments
  and agent docs in English.
- **Keep docs in sync**: a change to the API, CLI, manifest, gates, taxonomy or backends updates
  this file, README.md and the relevant doc in the same change.
- Before committing: `pnpm typecheck && pnpm test && pnpm build`.

## Layout

```
bin/forge.ts         agent CLI (also runs workers)
src/shared/          types, gates (phases.ts), what to do per gate (playbook.ts), review vocabulary (taxonomy.ts)
src/render/          backends: comfyui, openai, codex, command, mock; presets; input fetching for workers
src/server/          Hono API, SQLite (node:sqlite), storage, verdict export, next step, in-process worker
src/web/             React studio: library, new character, character page, review board, pick board
tools/               Python: qa_sprites, qa_zoom, cutout2
docs/                PLAYBOOK, RENDERING, MODELS, SILLYTAVERN
test/                Vitest
data/                runtime data (git-ignored)
```
