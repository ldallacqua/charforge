// The next step for a character, from its state alone (brief, profile, gates, batches, verdicts, jobs).
// This is what lets any agent resume the work at any point without the previous conversation:
// `forge next <slug>`. Priority: renders in flight, then batches waiting for the owner, then rejections
// to fix, then the first gate that is not signed off.

import { PHASES } from '../shared/phases.ts';
import { PLAYBOOK } from '../shared/playbook.ts';
import type { Batch, CharacterDetail, Job, NextStep } from '../shared/types.ts';

const gateLabel = (id: string) => {
  const p = PHASES.find((x) => x.id === id);
  return p ? `G${p.gate} ${p.label}` : id;
};

/** Submitted batches nobody followed up with a newer round (parentId) that still have rejections. */
function needsFix(batches: Batch[], gates: CharacterDetail['gates']): Batch | undefined {
  const parents = new Set(batches.map((b) => b.parentId).filter(Boolean));
  return batches
    .filter((b) => b.status === 'submitted' && !parents.has(b.id) && b.counts.rejected > 0)
    // once the owner signed a gate off, what was rejected in it is settled (design alternatives, a baseline test)
    .filter((b) => gates[b.phase]?.status !== 'done')
    // a pick batch with a pick and the rest rejected is a normal, finished pick
    .filter((b) => !(b.kind === 'pick' && b.counts.approved > 0))
    .sort((a, b) => a.id - b.id)[0];
}

export function nextStep(ch: CharacterDetail, jobs: Job[]): NextStep {
  const s = ch.slug;
  if (!ch.brief.trim()) {
    return {
      gate: 'g0', state: 'start',
      owner: 'Escrever o brief do personagem (como você quer que ele seja).',
      agent: `Ask the owner for the brief (who the character is, look, personality, what it is for) and save it: forge char brief ${s} @brief.md`,
      commands: [`forge char brief ${s} @brief.md`],
    };
  }
  if (!ch.profile) {
    return {
      gate: 'g0', state: 'start',
      owner: 'Escolher como as imagens são geradas (GPU local, ChatGPT, API).',
      agent: `Ask the owner which render profile to use and set it: forge profile ${s} --preset local|hybrid-codex|hybrid-api|sfw-codex`,
      commands: [`forge profile ${s} --preset local`],
    };
  }

  const running = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  if (running.length) {
    const backends = [...new Set(running.map((j) => j.backend))].join(', ');
    return {
      gate: running[0].phase, state: 'rendering', owner: null,
      agent: `${running.length} render job(s) in progress (${backends}); the images arrive as a new batch. If nothing picks them up, start a worker where those backends run: forge worker`,
      commands: ['forge worker'],
    };
  }

  const open = ch.batches.filter((b) => b.status === 'open').sort((a, b) => a.id - b.id)[0];
  if (open) {
    return {
      gate: open.phase, state: 'owner', batchId: open.id,
      owner: `Revisar o lote "${open.title}" (${open.counts.pending} pendentes).`,
      agent: `Batch #${open.id} (${gateLabel(open.phase)}) waits for the owner: run forge wait ${open.id} in the background, then act on the verdicts.`,
      commands: [`forge wait ${open.id}`],
    };
  }

  const fix = needsFix(ch.batches, ch.gates);
  if (fix) {
    return {
      gate: fix.phase, state: 'fix', batchId: fix.id, owner: null,
      agent: `Batch #${fix.id} "${fix.title}" (${gateLabel(fix.phase)}) has ${fix.counts.rejected} rejection(s). Read forge verdicts ${fix.id} --json, start from fixPlan, fix only the rejected items, then submit round ${fix.round + 1} with --parent ${fix.id} and each item's previous image.`,
      commands: [`forge verdicts ${fix.id} --json`, `forge submit --manifest round.json --parent ${fix.id}`],
    };
  }

  for (const phase of PHASES) {
    const g = phase.id;
    if (ch.gates[g]?.status === 'done') continue;
    const play = PLAYBOOK[g];
    const batches = ch.batches.filter((b) => b.phase === g);
    if (play.images && !batches.length) {
      return {
        gate: g, state: 'start', owner: play.ownerWhileStart,
        agent: `${play.start.replaceAll('<slug>', s)} (procedure: ${play.doc})`,
        commands: [`forge render --char ${s} --rating sfw --prompt "..." --submit --phase ${g} --title "..."`],
      };
    }
    if (!play.images) {
      return {
        gate: g, state: 'start', owner: play.ownerWhileStart,
        agent: `${play.start.replaceAll('<slug>', s)} (procedure: ${play.doc})`,
        commands: [`forge gate ${s} ${g} done --note "..."`],
      };
    }
    return {
      gate: g, state: 'signoff',
      owner: `Nada pendente em ${gateLabel(g)}. Conclua a fase na página do personagem, ou peça outra rodada.`,
      agent: g === 'g2'
        ? 'Discovery has no open rejections. If the owner has not settled on one design, run the next round from what they liked (like.* reasons, notes); otherwise ask the owner to sign off G2.'
        : `Install what was approved or picked, then ask the owner to sign off ${gateLabel(g)} on the character page (or forge gate ${s} ${g} done once the owner said so).`,
      commands: [`forge gate ${s} ${g} done --note "..."`],
    };
  }
  return { gate: null, state: 'done', owner: null, agent: 'Every gate is signed off. The character is done.', commands: [] };
}
