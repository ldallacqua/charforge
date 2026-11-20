// The review vocabulary. The owner clicks these; the agent reads `fix` to know what to do next.
// Codes are stable (stored in the database and read by agents): add new ones, never rename.
// Labels are Portuguese (what the owner sees); fixes are English (what the agent acts on).

import type { RegionKind } from './types.ts';

export interface Reason {
  code: string;
  label: string;
  fix: string;
}

export interface Area {
  id: string;
  label: string;
  /** region kinds whose loupe opens this area first */
  kinds: RegionKind[];
  reasons: Reason[];
}

export const AREAS: Area[] = [
  {
    id: 'concept',
    label: 'Conceito',
    kinds: [],
    reasons: [
      { code: 'concept.off_brief', label: 'Fora do que pedi', fix: 'Re-read the brief and the owner notes; the next round must change what the owner named, not just the seed.' },
      { code: 'concept.generic', label: 'Genérico demais', fix: 'Push one distinctive idea (silhouette, accessory, palette) instead of a safe average; give the next options real variety.' },
      { code: 'concept.silhouette', label: 'Silhueta fraca', fix: 'Make the outline readable in black: bigger shapes (horns, hair mass, sleeves, wings), less noise inside.' },
      { code: 'concept.palette', label: 'Cores não combinam', fix: 'Try 2-3 palettes on the liked design (same line art) before redesigning.' },
      { code: 'concept.busy', label: 'Detalhe demais', fix: 'Remove small ornaments: fine detail does not survive the local model or the LoRA (lesson from Rin). Keep 3-5 strong anchors.' },
      { code: 'concept.style', label: 'Estilo não é esse', fix: 'Wrong rendering style: match the style reference or switch the model / style LoRA for the next options.' },
      { code: 'concept.young', label: 'Parece jovem demais', fix: 'Adult proportions and face: "mature female, adult", taller, longer face, and the age negatives. Never submit an ambiguous one again.' },
    ],
  },
  {
    id: 'hands',
    label: 'Mãos',
    kinds: ['hand'],
    reasons: [
      { code: 'hands.extra_fingers', label: 'Dedos a mais', fix: 'Re-render the hand crop at denoise 0.55-0.65 with a shape prompt (palm direction, "four fingers together, one thumb"), 8 seeds; pick at >=400 px per hand; paste the whole render square.' },
      { code: 'hands.missing_fingers', label: 'Dedos a menos', fix: 'Same as extra fingers: shape prompt that names the visible fingers, 8 seeds, pick at counting scale.' },
      { code: 'hands.ghost_finger', label: 'Dedo fantasma', fix: 'A translucent leftover of the old hand: paste the whole render square (no feathered ellipse) or widen the mask so no old pixels survive.' },
      { code: 'hands.fused', label: 'Dedos fundidos', fix: 'Re-render the hand at denoise 0.5 with "separate fingers, visible gaps"; if it persists, change the pose to a closed or partly hidden hand.' },
      { code: 'hands.nails', label: 'Unhas sumiram', fix: 'Hand detail pass at 2x (1024 px crop, denoise ~0.38, "red nails, glossy nail polish"), then re-composite.' },
      { code: 'hands.soft', label: 'Dedos sem definição', fix: 'Hand detail pass at 2x with the LoRA, low denoise; check the composite did not resample it down twice.' },
      { code: 'hands.pose', label: 'Pose da mão estranha', fix: 'Change the hand pose in the base (easier pose, partly hidden, holding something) instead of fixing it per image.' },
      { code: 'hands.inconsistent', label: 'Muda entre expressões', fix: 'Take the hand from the approved base for every expression of the pose (handfix.py), never from the face pass.' },
    ],
  },
  {
    id: 'face',
    label: 'Rosto e olhos',
    kinds: ['face', 'eyes', 'mouth'],
    reasons: [
      { code: 'face.eyes_asymmetric', label: 'Olhos assimétricos', fix: 'Face detail pass on the eyes (crop at 2x, denoise 0.35-0.45), or inpaint one eye from the other.' },
      { code: 'face.eye_color', label: 'Cor dos olhos errada', fix: 'Put the eye colour in the face-pass prompt with weight; recolour the iris if the shape is fine.' },
      { code: 'face.pupils', label: 'Pupilas ou íris ruins', fix: 'Eye detail pass at 2x with "detailed eyes, clear pupils"; check both eyes look the same way.' },
      { code: 'face.off_model', label: 'Fora do modelo', fix: 'Identity drift: raise the LoRA weight in the face pass or use the approved anchor face as reference; compare with the G2 anchors.' },
      { code: 'face.expression', label: 'Expressão não bate', fix: 'The face does not read as the label: rewrite the expression prompt (eyebrows, mouth, eyes) and re-run the face pass for this one.' },
      { code: 'face.mouth', label: 'Boca ou dentes ruins', fix: 'Small inpaint on the mouth at 2x; avoid open mouths with teeth if they keep failing.' },
    ],
  },
  {
    id: 'hair',
    label: 'Cabelo e chifres',
    kinds: ['hair', 'horns'],
    reasons: [
      { code: 'hair.artifact', label: 'Artefato no cabelo', fix: 'Inpaint the spot at 2x; check it is not a cutout pocket first.' },
      { code: 'hair.color', label: 'Cor do cabelo errada', fix: 'Hair colour drift: add the colour with weight and recolour the region.' },
      { code: 'hair.shape', label: 'Corte ou volume errado', fix: 'Off-model hairstyle: compare with the anchors; regenerate the base pose rather than patching.' },
      { code: 'hair.horns', label: 'Chifres errados', fix: 'Horn shape or count wrong: inpaint from the anchor design (prompt the horn shape explicitly).' },
    ],
  },
  {
    id: 'feet',
    label: 'Pés e pernas',
    kinds: ['feet'],
    reasons: [
      { code: 'feet.toes', label: 'Dedos do pé errados', fix: 'Feet detail pass at 2x with "detailed feet, five toes"; or shoes / a pose that hides the toes.' },
      { code: 'feet.shape', label: 'Pé deformado', fix: 'Re-render the feet crop at denoise 0.5 with a pose prompt; keep both feet on one ground line.' },
      { code: 'feet.legs', label: 'Pernas erradas', fix: 'Leg length or joint wrong: fix in the pose base (OpenPose skeleton), not per expression.' },
      { code: 'feet.cropped', label: 'Pés cortados', fix: 'Full-body master must show the feet with margin: outpaint the bottom or re-render on a taller canvas.' },
    ],
  },
  {
    id: 'body',
    label: 'Corpo',
    kinds: ['body'],
    reasons: [
      { code: 'body.anatomy', label: 'Anatomia errada', fix: 'Fix the pose base (skeleton, proportions) and re-derive the expressions from it.' },
      { code: 'body.proportions', label: 'Proporções fora do card', fix: 'Body does not match the spec (height, chest, build): adjust the prompt and the negative, re-run the pose.' },
      { code: 'body.extra_limb', label: 'Membro a mais', fix: 'Inpaint the extra limb away at 2x, then re-run the cutout.' },
    ],
  },
  {
    id: 'outfit',
    label: 'Roupa e acessórios',
    kinds: ['outfit', 'accessory'],
    reasons: [
      { code: 'outfit.wrong', label: 'Roupa errada', fix: 'Outfit drift: use the outfit trigger with weight; repaint from the approved base.' },
      { code: 'outfit.accessory_missing', label: 'Acessório sumiu', fix: 'Restore the accessory region from the approved base (below-chin restore) or inpaint it.' },
      { code: 'outfit.accessory_color', label: 'Cor do acessório muda', fix: 'Take the accessory pixels from the base for every expression so it cannot drift.' },
    ],
  },
  {
    id: 'creature',
    label: 'Asas e cauda',
    kinds: ['wings', 'tail'],
    reasons: [
      { code: 'creature.wings', label: 'Asas erradas', fix: 'Wing shape, count or attachment wrong: prompt "folded wings" or inpaint from the anchor; wings must grow from the back.' },
      { code: 'creature.tail', label: 'Cauda errada', fix: 'Tail must leave from the lower back, one tail, the anchor tip: inpaint or regenerate.' },
      { code: 'creature.wrong_body', label: 'Sai do corpo errado', fix: 'A wing or tail attached to another figure: use POV for couples, "folded wings", and a regional prompt; regenerate the scene.' },
    ],
  },
  {
    id: 'cutout',
    label: 'Recorte',
    kinds: ['edge'],
    reasons: [
      { code: 'cutout.pocket', label: 'Fundo não recortado', fix: 'Background pocket kept as opaque: cutout2 pocket rule (check the ring share) or mark the pocket for removal by hand.' },
      { code: 'cutout.halo', label: 'Halo na borda', fix: 'Light rim on dark scenes: re-solve the edge band against the known background (cutout2 projection), check on the magenta background.' },
      { code: 'cutout.jagged', label: 'Borda serrilhada', fix: 'Soften the alpha at that edge (1-2 px feather) or re-run the segmenter on a 2x upscale.' },
      { code: 'cutout.ate_part', label: 'Recorte comeu parte', fix: 'Segmenter removed part of the figure (thin strands, claws, light areas): restore from the source with a hand-drawn mask.' },
      { code: 'cutout.specks', label: 'Sujeira solta', fix: 'Drop small detached components and re-check at 3x.' },
    ],
  },
  {
    id: 'style',
    label: 'Estilo e técnica',
    kinds: ['other'],
    reasons: [
      { code: 'style.drift', label: 'Estilo diferente do resto', fix: 'Style drift vs the approved set: same model, LoRA weight, sampler and finishing chain as the reference images.' },
      { code: 'style.low_detail', label: 'Pouco detalhe', fix: 'Missing the hires pass or the detail pass: run the full finishing chain (hires 1.5x at 0.4, face and hand detail).' },
      { code: 'style.noise', label: 'Ruído ou manchas', fix: 'Artefacts from too high denoise or a bad seed: re-run the last pass with another seed or lower denoise.' },
      { code: 'style.colors', label: 'Cores erradas', fix: 'Palette drift: compare with the anchors, recolour or regenerate.' },
    ],
  },
  {
    id: 'framing',
    label: 'Enquadramento',
    kinds: [],
    reasons: [
      { code: 'framing.cropped', label: 'Cortado onde não devia', fix: 'Head, hands or feet touch the edge: outpaint or re-render with more margin.' },
      { code: 'framing.scale', label: 'Escala ou posição diferente', fix: 'Normalise the figure height and position to the set (buildset.py finish) so sprites do not jump.' },
      { code: 'framing.pose_label', label: 'Pose não combina', fix: 'The body language contradicts the expression label: move this expression to another pose group.' },
    ],
  },
];

/** Discovery (G2): what the owner liked in a concept, so the next round can combine the liked parts. */
export const LIKES: Reason[] = [
  { code: 'like.face', label: 'Rosto', fix: 'Keep this face (shape, eyes, expression range) in the next round.' },
  { code: 'like.hair', label: 'Cabelo', fix: 'Keep this hairstyle and hair colour.' },
  { code: 'like.outfit', label: 'Roupa', fix: 'Keep this outfit design.' },
  { code: 'like.palette', label: 'Cores', fix: 'Keep this palette (note the hex values).' },
  { code: 'like.silhouette', label: 'Silhueta', fix: 'Keep this silhouette and proportions.' },
  { code: 'like.accessories', label: 'Acessórios', fix: 'Keep these accessories (horns, jewellery, props).' },
  { code: 'like.vibe', label: 'Clima', fix: 'Keep the mood: expression, pose attitude, lighting.' },
  { code: 'like.style', label: 'Estilo', fix: 'Keep this rendering style (model, LoRA, finishing).' },
];

/** Reasons to approve. Optional, but they teach the agent what "good" looks like. */
export const APPROVALS: Reason[] = [
  { code: 'ok.great', label: 'Excelente', fix: 'Keep as is. Good reference for future work.' },
  { code: 'ok.acceptable', label: 'Aceitável', fix: 'Keep. Not a reference.' },
  { code: 'ok.improved', label: 'Melhorou', fix: 'The fix worked: keep the recipe that produced this round.' },
  { code: 'ok.reference', label: 'Usar como referência', fix: 'Use as a style or identity reference (anchor, dataset, comparison).' },
  { code: 'ok.waiver', label: 'Aceito com defeito', fix: 'Known minor defect accepted: record it as a waiver, do not fix now.' },
];

const all = new Map<string, Reason & { area: string }>();
for (const area of AREAS) for (const r of area.reasons) all.set(r.code, { ...r, area: area.id });
for (const r of APPROVALS) all.set(r.code, { ...r, area: 'approve' });
for (const r of LIKES) all.set(r.code, { ...r, area: 'like' });

export function reasonOf(code: string): (Reason & { area: string }) | undefined {
  return all.get(code);
}

export function isApproval(code: string): boolean {
  return code.startsWith('ok.') || code.startsWith('like.');
}

/** Discovery batches judge taste ("gostei de"), not defects. */
export function isDiscovery(phase: string | undefined): boolean {
  return phase === 'g2';
}

export function approvalsFor(phase: string | undefined): Reason[] {
  return isDiscovery(phase) ? LIKES : APPROVALS;
}

/** Areas to show first for a region kind, then the rest. */
export function areasFor(kind: RegionKind | null, phase?: string): Area[] {
  const ordered = isDiscovery(phase) ? AREAS : [...AREAS.filter((a) => a.id !== 'concept'), AREAS.find((a) => a.id === 'concept')!];
  if (!kind) return ordered;
  const first = ordered.filter((a) => a.kinds.includes(kind));
  return [...first, ...ordered.filter((a) => !first.includes(a))];
}

export const REGION_KIND_LABEL: Record<RegionKind, string> = {
  face: 'Rosto', eyes: 'Olhos', mouth: 'Boca', hair: 'Cabelo', horns: 'Chifres',
  hand: 'Mão', feet: 'Pés', body: 'Corpo', outfit: 'Roupa', accessory: 'Acessório',
  wings: 'Asas', tail: 'Cauda', edge: 'Borda', other: 'Detalhe',
};
