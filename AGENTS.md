# AGENTS.md

How an agent works with the Charforge studio. The owner reviews; the agent generates, submits, waits and
fixes. The owner's time is the scarce resource: never send them something an automatic check would catch.

## The review loop

1. **Generate** the phase's images (pipeline: `~/services/sillytavern/charforge`, guides:
   `~/services/sillytavern/docs/characters`).
2. **Check automatically first.** Run the phase's automatic QA (`qa_sprites.py` for sprites). Fix every
   FAIL before submitting. Put the results in each item's `checks` so the owner sees them.
3. **Look yourself at counting scale** (each hand ≥ 400 px on screen). The studio is the second pair of
   eyes, not the first.
4. **Submit** a batch with `forge submit`. Every item gets:
   - `regions` for every hand, the eyes, the face, and, when visible, feet, horns, wings, tail, and any
     edge the automatic QA flagged. Boxes in the image's own pixels. Same `label` for the same body part
     across items (the studio keeps the loupe on that label when the owner flips images).
   - `previous` when the image replaces one the owner has seen (a fix, a new round).
   - `group` (pose, outfit set, candidate group) and `meta` (set, pose, expression, seed, recipe).
5. **Wait** with `forge wait <id>` (run it in the background; it returns when the owner submits).
6. **Read** `forge verdicts <id> --json`. Start from `fixPlan` (reasons grouped, most frequent first);
   each reason carries the `fix` to apply. Use `pins[].box` and `regions[].box` for where.
7. **Fix only what was rejected.** Approved items are locked: never regenerate them unless the owner asks.
   Resubmit the fixed items as a new round: `forge submit ... --parent <id>`, each with `previous`.
8. **Picks**: for seeds, epochs or variants, submit `--kind pick` with one `group` per decision. Install
   exactly what `picks` says. A group with `null` means every candidate was rejected: read their reasons.
9. When a phase has no rejections left, it is done (the phase track turns green); move to the next gate.

## Manifest

```json
{
  "character": "rin",
  "phase": "g5",
  "kind": "review",
  "title": "Sprites v6: mãos refeitas",
  "notes": "What changed and what to look at, in Portuguese.",
  "parentId": 12,
  "items": [
    {
      "file": "out/joy.png",
      "previous": "old/joy.png",
      "label": "joy",
      "group": "Vestida, P5 braços abertos",
      "meta": { "set": "gown", "pose": "P5", "expression": "joy" },
      "regions": [
        { "kind": "hand", "label": "Mão esquerda", "box": [0, 520, 200, 760] },
        { "kind": "eyes", "label": "Olhos", "box": [335, 370, 555, 475] }
      ],
      "checks": [{ "name": "qa_sprites", "status": "pass", "detail": "halo 0.21%" }]
    }
  ]
}
```

Paths are relative to the manifest. Region kinds: `face eyes mouth hair horns hand feet body outfit
accessory wings tail edge other`. Phases: `g0`–`g8` (see `src/shared/phases.ts`). Check status:
`pass warn fail info`.

## Rules

- **Never commit `data/`** (images can be NSFW, and it holds the database).
- Reason codes in `src/shared/taxonomy.ts` are stored in the database and read by agents: add new codes,
  never rename or remove one. Labels are Portuguese (owner-facing), `fix` texts are English.
- UI copy is Portuguese (pt-BR), sentence case, plain verbs. Code and comments are English.
- Sprite masters are **full body** (head to feet with margin); waist-up and bust crops are derived from
  the master, never generated separately. Always give the feet a region.
- Keep `README.md` and this file in sync with any change to the API, the manifest, the CLI or the loop.
- Run `pnpm typecheck && pnpm test && pnpm build` before committing.

## Layout

```
bin/forge.ts            agent CLI
src/shared/             types, phases (gates), taxonomy (reasons + fixes) — used by all sides
src/server/             Hono API, SQLite (node:sqlite), image storage, verdict export
src/web/                React app (review board, pick board, library, character page)
test/                   Vitest
data/                   runtime data, git-ignored
```
