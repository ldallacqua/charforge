// The character pipeline as a sequence of gates. Same gates as the QA guide
// (sillytavern/docs/characters/QA.md): a gate opens only when the previous one passed.

import type { RegionKind } from './types.ts';

export interface Phase {
  id: string;
  gate: number;
  label: string;
  /** what the owner looks at in this phase */
  focus: string;
  /** loupes the agent should always provide in this phase */
  regions: RegionKind[];
}

export const PHASES: Phase[] = [
  { id: 'g0', gate: 0, label: 'Licença e idade', focus: 'Personagem adulto, uso permitido de cada modelo.', regions: [] },
  { id: 'g1', gate: 1, label: 'Card', focus: 'Voz, regras e lore na conversa de teste.', regions: [] },
  { id: 'g2', gate: 2, label: 'Design', focus: 'Descoberta: diga do que gostou em cada conceito, para a próxima rodada juntar as partes. Depois, as âncoras: o design aguenta o modelo local nas 20 gerações.', regions: ['face', 'hair', 'outfit'] },
  { id: 'g3', gate: 3, label: 'Dataset', focus: 'Cada imagem limpa e no modelo; cobertura de ângulos e roupas.', regions: ['face', 'hand', 'outfit'] },
  { id: 'g4', gate: 4, label: 'LoRA', focus: 'Identidade e roupa só com os gatilhos; separação entre roupa e corpo.', regions: ['face', 'outfit'] },
  { id: 'g5', gate: 5, label: 'Sprites', focus: 'Mãos com 400 px ou mais na tela, olhos, pés, bordas no fundo escuro, igual entre expressões.', regions: ['face', 'eyes', 'hand', 'feet', 'edge'] },
  { id: 'g6', gate: 6, label: 'Cenários e CGs', focus: 'Acabamento a 100%: asas e cauda no corpo certo, mãos, POV.', regions: ['face', 'hand', 'wings', 'tail'] },
  { id: 'g7', gate: 7, label: 'Integração', focus: 'Tudo junto no SillyTavern: sprite, fundo e CG em cada passo do roteiro.', regions: [] },
  { id: 'g8', gate: 8, label: 'Aprovação', focus: 'Aprovação final do dono.', regions: [] },
];

export function phaseOf(id: string): Phase | undefined {
  return PHASES.find((p) => p.id === id);
}
