# Models and licences

Situation in November 2026, for a 24 GB GPU (RTX 4090). Check G0: every model a character uses must allow
the intended use (personal, commercial, NSFW).

| Task | Model | Notes | Licence |
|---|---|---|---|
| Local anime generation: sprites, CGs, NSFW | **WAI-Illustrious-SDXL v17** / Illustrious XL | Danbooru tags, the largest LoRA ecosystem, predictable | Fair AI Public License (commercial ok) |
| Explicit and niche tags | NoobAI-XL (vpred; eps for compatibility) | Danbooru + e621, stronger NSFW, drifts more | same |
| Local reference editing (angles, sheets, RGBA) | Qwen-Image 2.1 (7B, up to 10 references, native transparency) | great for building a dataset | **research, non-commercial** |
| Local reference editing, commercial | FLUX 3 Image Klein (5.6B, 10 references) | the commercial alternative | FLUX community (check the limit) |
| Newer anime DiTs | MOSS-Image (Apache 2.0), Anima (2B) | promising; immature LoRA ecosystem, worse hands | MOSS ok / Anima non-commercial |
| Showcase SFW (cloud) | GPT Image 2, Nano Banana 2 | best composition and detail | provider terms; NSFW blocked |
| Animated CGs | Wan 2.2 (14B quantised or 5B), LTX-2.3 | image to video loops | Wan Apache 2.0; LTX revenue cap |
| Upscale | UltimateSDUpscale (anime ESRGAN + low-denoise tiles), SeedVR2 tiled | detail without photo texture | — |
| Cutout | `tools/cutout2.py`: BiRefNet (rembg) + known-background clean-up; or native transparency | isnet-anime with alpha matting left pockets and halos | rembg: MIT |
| LoRA training | kohya `sd-scripts` | see PLAYBOOK G4 | Apache 2.0 |

Useful ComfyUI additions (third-party code: review before installing):

- **ComfyUI-Impact-Pack**: automatic face and hand detailers by detection (and the detectors that could
  create review regions automatically).
- **ControlNet for SDXL/Illustrious** (OpenPose, lineart, depth) with the preprocessors pack.
- **Krita AI Diffusion** for paint-over with the same ComfyUI.
- A LoRA tag loader node if prompts carry `<lora:name:weight>` tags (chat image extensions do).

Training on a provider's outputs (for example a style LoRA on GPT images) must respect that provider's
terms. Games on Steam must disclose AI content.
