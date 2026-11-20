# Installing a character in SillyTavern (G7)

Paths are relative to the SillyTavern data folder (`data/default-user/`). Edit `settings.json` only with
SillyTavern closed, or save and reload right away: extensions keep their own copy of their settings and
write it back. After changing a card, lorebook or settings, reload every open SillyTavern tab (an old tab
keeps writing the old state).

## Files

| What | Where |
|---|---|
| Card | `characters/<Name>.png` (V2/V3 card), avatar 2:3 |
| Lorebook | `worlds/<World>.json`, linked from the card (`extensions.world`) and embedded as `character_book` |
| Sprites, canonical outfit | `characters/<Name>/<label>.png`, the 28 labels (PLAYBOOK G5): 832 x 1367 crops of the masters finished at 2x |
| Sprites, other outfits | `characters/<Name>/<outfit>/<label>.png` (`nude/`, `robe/`...) |
| Backgrounds | `backgrounds/<Realm> - <Place>.jpg` |

Back up the old sprites before installing new ones.

## Expressions

Use LLM classification (`extension_settings.expressions.api = 2`, prompt type `raw`, fallback
`neutral`): the sprite changes **once**, about 1.5 s after the reply ends. The local classifier
(`api = 0`) re-classifies every 10 s while the reply streams, with partial text, so the sprite changes
2-3 times per reply. Cost: one short call to the chat model per reply.

## Images during the chat

- Character prompt (`extension_settings.sd.character_prompts[<avatar>]`): the LoRA, the triggers and the
  anchors, for example
  `<lora:rin_v1:1>, rinsuccubus, dark fantasy, 1girl, mature female, adult, short hair, red hair, green eyes, rin_gown, black dress, ...`
  and the character negative (`character_negative_prompts`).
- The image workflow needs the hires pass (for example 1152 x 896 to 1728 x 1344, second pass at
  denoise 0.4) and a LoRA tag loader if the prompt carries `<lora:...>` tags.
- Tag rules for the LLM that writes image prompts: 15-30 tags, spaces not underscores, one framing, no
  repeated appearance, couples in POV (`1boy, hetero, pov, pov hands`), `folded wings` for winged
  characters, and `multiple views, split screen, comic, 2koma, panels, diptych, collage, border` in the
  negative.
- Outfit changes (dressed / undressed), place changes and when to draw a CG are best decided by a
  separate classifier call after each reply, not by markers inside the roleplay reply (the model forgets
  them). The owner's setup uses a small custom extension for this (switches the costume folder, the
  outfit tags in the image prompt, the background, and shows CGs full screen); any equivalent works.

## Test script

Run PLAYBOOK G7's six steps in a new chat, show the owner the end state of each, delete the chat.
