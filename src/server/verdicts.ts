// The agent-facing export of a reviewed batch: every verdict with its reasons expanded into fix hints,
// plus a fix plan (reasons grouped, most frequent first) so the agent knows where to start.

import { isApproval, reasonOf } from '../shared/taxonomy.ts';
import type { BatchDetail, Box } from '../shared/types.ts';

export interface ReasonOut {
  code: string;
  label: string;
  fix: string;
}

const expand = (code: string): ReasonOut => {
  const r = reasonOf(code);
  return { code, label: r?.label ?? code, fix: r?.fix ?? '' };
};

const norm = (b: Box, w: number, h: number) => [b[0] / w, b[1] / h, b[2] / w, b[3] / h].map((v) => Math.round(v * 1000) / 1000);

export function exportVerdicts(batch: BatchDetail) {
  const items = batch.items.map((it) => {
    const rv = it.review;
    return {
      id: it.id,
      label: it.label,
      group: it.group,
      source: it.source,
      size: [it.width, it.height],
      verdict: rv.verdict ?? 'pending',
      reasons: rv.reasons.map(expand),
      regions: it.regions
        .map((g) => ({ ...g, mark: rv.regions[g.id] }))
        .filter((g) => g.mark)
        .map((g) => ({ id: g.id, kind: g.kind, label: g.label, box: g.box, verdict: g.mark!.verdict, reasons: g.mark!.reasons.map(expand) })),
      pins: rv.pins.map((p) => ({ box: p.box, boxNorm: norm(p.box, it.width, it.height), reason: p.reason ? expand(p.reason) : null, note: p.note ?? '' })),
      note: rv.note,
    };
  });

  // problems grouped by reason, wherever they were attached (item, region or pin)
  const plan = new Map<string, { code: string; label: string; fix: string; count: number; items: string[] }>();
  const add = (code: string, label: string) => {
    if (isApproval(code)) return;
    const e = plan.get(code) ?? { ...expand(code), count: 0, items: [] };
    e.count++;
    if (!e.items.includes(label)) e.items.push(label);
    plan.set(code, e);
  };
  for (const it of items) {
    for (const r of it.reasons) add(r.code, it.label);
    for (const g of it.regions) for (const r of g.reasons) add(r.code, `${it.label} (${g.label})`);
    for (const p of it.pins) if (p.reason) add(p.reason.code, `${it.label} (pin)`);
  }

  const picks: Record<string, { id: number; label: string; source: string | null } | null> = {};
  if (batch.kind === 'pick') {
    for (const it of batch.items) {
      if (!(it.group in picks)) picks[it.group] = null;
      if (it.review.verdict === 'approve') picks[it.group] = { id: it.id, label: it.label, source: it.source };
    }
  }

  return {
    batch: {
      id: batch.id, character: batch.characterSlug, phase: batch.phase, kind: batch.kind, title: batch.title,
      round: batch.round, parentId: batch.parentId, status: batch.status, submittedAt: batch.submittedAt, ownerNote: batch.ownerNote,
    },
    summary: batch.counts,
    fixPlan: [...plan.values()].sort((a, b) => b.count - a.count),
    picks: batch.kind === 'pick' ? picks : undefined,
    items,
  };
}

export type VerdictExport = ReturnType<typeof exportVerdicts>;

/** Submitting needs every item decided; a pick batch needs one pick (or all rejected) per group. */
export function submitBlockers(batch: BatchDetail): string[] {
  if (batch.kind === 'review') {
    const n = batch.counts.pending;
    return n ? [`${n} ${n === 1 ? 'imagem sem veredito' : 'imagens sem veredito'}`] : [];
  }
  const groups = new Map<string, { picked: boolean; open: boolean }>();
  for (const it of batch.items) {
    const g = groups.get(it.group) ?? { picked: false, open: false };
    if (it.review.verdict === 'approve') g.picked = true;
    if (it.review.verdict === null) g.open = true;
    groups.set(it.group, g);
  }
  return [...groups.entries()].filter(([, g]) => !g.picked && g.open).map(([name]) => `grupo ${name || '(sem nome)'} sem escolha`);
}
