// What to do at the start of each gate. `forge next` and the character page read this, so any agent
// (Claude, Codex, Gemini...) and the owner see the same next step. The full procedure for each gate is in
// docs/PLAYBOOK.md (the anchors below).

export interface GatePlay {
  /** image gates go through review batches; text gates are signed off directly */
  images: boolean;
  /** for the agent, in English */
  start: string;
  /** for the owner, in Portuguese, while the agent works */
  ownerWhileStart: string;
  doc: string;
}

export const PLAYBOOK: Record<string, GatePlay> = {
  g0: {
    images: false,
    start: 'Confirm the character is an adult (say so in the brief and the card), choose the render profile with the owner, and check the licence of every model in the profile (docs/MODELS.md). Then: forge gate <slug> g0 done --note "...".',
    ownerWhileStart: 'Confirmar que o personagem é adulto e escolher como as imagens são geradas.',
    doc: 'docs/PLAYBOOK.md#g0-brief-age-and-licences',
  },
  g1: {
    images: false,
    start: 'Write the character card from the brief (description, personality, scenario, first message, example dialogue) and the lorebook. Run the 10-message test chat and show the owner the excerpt. When the owner approves: forge gate <slug> g1 done --note "...".',
    ownerWhileStart: 'Ler o trecho da conversa de teste e aprovar a voz e o lore.',
    doc: 'docs/PLAYBOOK.md#g1-card-and-lorebook',
  },
  g2: {
    images: true,
    start: 'Discovery round 1: from the brief, write 8-12 genuinely different concepts (silhouette, outfit, palette, mood), full body on a plain background, SFW backend. forge render --char <slug> --rating sfw --prompt "..." --submit --phase g2 --title "Conceitos, rodada 1" (one call per concept, or a manifest). Then refine from what the owner liked (like.* reasons) until the owner picks one design; then the turnaround sheet and the 20 blind anchor generations on the local model.',
    ownerWhileStart: 'Esperar as primeiras opções de conceito.',
    doc: 'docs/PLAYBOOK.md#g2-design-discovery-and-anchors',
  },
  g3: {
    images: true,
    start: 'Build the LoRA dataset from the approved design: 40-60 images covering close-ups, waist-up, full body, side and back, and every outfit state (NSFW ones on the local backend). Submit it in batches by outfit state with a face and hand region on each.',
    ownerWhileStart: 'Esperar o dataset.',
    doc: 'docs/PLAYBOOK.md#g3-dataset',
  },
  g4: {
    images: true,
    start: 'Train the LoRA on the local GPU (docs/PLAYBOOK.md#g4-lora), then submit a pick batch: one group per test prompt, one candidate per saved epoch, same seed. The owner picks the epoch.',
    ownerWhileStart: 'Esperar o treino da LoRA e escolher a melhor época.',
    doc: 'docs/PLAYBOOK.md#g4-lora',
  },
  g5: {
    images: true,
    start: 'Sprites: one full-body master per pose (head to feet, margin top and bottom), expressions by face pass, hands from the approved base, cutout, then the display crop. Run qa_sprites first; submit with regions on every hand, the eyes, the face and the feet, and `previous` on re-renders.',
    ownerWhileStart: 'Esperar as sprites.',
    doc: 'docs/PLAYBOOK.md#g5-sprites',
  },
  g6: {
    images: true,
    start: 'Backgrounds (one per lorebook place, no people) and 3 sample CGs at 100% finishing. Couples in POV, folded wings, tail checked. Submit with hand, face, wing and tail regions.',
    ownerWhileStart: 'Esperar cenários e CGs.',
    doc: 'docs/PLAYBOOK.md#g6-backgrounds-and-cgs',
  },
  g7: {
    images: false,
    start: 'Install everything in the target app (SillyTavern: docs/SILLYTAVERN.md) and run the 6-step integration script in a test chat. Show the owner the end state of each step, delete the test chat. Then: forge gate <slug> g7 done.',
    ownerWhileStart: 'Testar o personagem no app e dizer se está tudo certo.',
    doc: 'docs/PLAYBOOK.md#g7-integration',
  },
  g8: {
    images: false,
    start: 'Ask the owner for the final approval on the character page. Make sure backups exist and the docs are current.',
    ownerWhileStart: 'Dar a aprovação final na página do personagem.',
    doc: 'docs/PLAYBOOK.md#g8-approval',
  },
};
