import { describe, expect, it } from 'vitest';
import { openDb } from '../src/server/db.ts';
import { exportVerdicts, submitBlockers } from '../src/server/verdicts.ts';
import { AREAS, APPROVALS, reasonOf } from '../src/shared/taxonomy.ts';

function seed(kind: 'review' | 'pick') {
  const db = openDb(':memory:');
  const ch = db.createCharacter({ slug: 'rin', name: 'Rin' });
  const batchId = db.createBatch({ characterId: ch.id, phase: 'g5', kind, title: 't', notes: '', parentId: null });
  const ids = ['a', 'b', 'c'].map((label, i) =>
    db.addItem({
      batchId, position: i, label, group: kind === 'pick' ? 'P3' : '', file: `rin/1/${label}.png`, thumb: `rin/1/${label}.webp`, prevFile: null,
      width: 832, height: 1367, hasAlpha: true, source: `/src/${label}.png`, meta: {},
      regions: [{ id: 'r1', kind: 'hand', label: 'Mão no peito', box: [360, 560, 600, 760] }], checks: [],
    }),
  );
  return { db, batchId, ids };
}

const blank = { verdict: null, reasons: [], regions: {}, pins: [], note: '', updatedAt: null };

describe('taxonomy', () => {
  it('has unique, stable-looking codes with a fix for every problem', () => {
    const codes = [...AREAS.flatMap((a) => a.reasons), ...APPROVALS].map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[a-z]+\.[a-z_]+$/);
    for (const a of AREAS) for (const r of a.reasons) expect(reasonOf(r.code)?.fix.length).toBeGreaterThan(20);
  });
});

describe('review batches', () => {
  it('blocks submission until every image has a verdict', () => {
    const { db, batchId, ids } = seed('review');
    db.saveReview(ids[0], { ...blank, verdict: 'approve' });
    db.saveReview(ids[1], { ...blank, verdict: 'reject', reasons: ['hands.extra_fingers'] });
    expect(submitBlockers(db.getBatch(batchId)!)).toEqual(['1 imagem sem veredito']);
    db.saveReview(ids[2], { ...blank, verdict: 'approve' });
    expect(submitBlockers(db.getBatch(batchId)!)).toEqual([]);
  });

  it('exports a fix plan grouped by reason, across item, region and pin', () => {
    const { db, batchId, ids } = seed('review');
    db.saveReview(ids[0], {
      ...blank, verdict: 'reject', reasons: ['hands.extra_fingers'],
      regions: { r1: { verdict: 'bad', reasons: ['hands.ghost_finger'] } },
      pins: [{ id: 'p1', box: [400, 600, 440, 640], reason: 'hands.ghost_finger', note: 'perto do polegar' }],
    });
    db.saveReview(ids[1], { ...blank, verdict: 'reject', reasons: ['hands.extra_fingers'] });
    db.saveReview(ids[2], { ...blank, verdict: 'approve', reasons: ['ok.great'] });
    const v = exportVerdicts(db.getBatch(batchId)!);
    expect(v.summary).toEqual({ total: 3, approved: 1, rejected: 2, pending: 0 });
    expect(v.fixPlan.map((f) => [f.code, f.count])).toEqual([['hands.extra_fingers', 2], ['hands.ghost_finger', 2]]);
    expect(v.items[0].pins[0].boxNorm).toEqual([0.481, 0.439, 0.529, 0.468]);
    expect(v.items[0].regions[0]).toMatchObject({ label: 'Mão no peito', verdict: 'bad' });
    expect(v.fixPlan.every((f) => !f.code.startsWith('ok.'))).toBe(true);
  });
});

describe('pick batches', () => {
  it('keeps one pick per group and reports it', () => {
    const { db, batchId, ids } = seed('pick');
    db.saveReview(ids[0], { ...blank, verdict: 'approve' });
    db.saveReview(ids[1], { ...blank, verdict: 'approve' });
    db.clearOtherPicks(ids[1]);
    const b = db.getBatch(batchId)!;
    expect(b.items.map((i) => i.review.verdict)).toEqual([null, 'approve', null]);
    expect(submitBlockers(b)).toEqual([]);
    expect(exportVerdicts(b).picks).toEqual({ P3: { id: ids[1], label: 'b', source: '/src/b.png' } });
  });

  it('accepts a group where every candidate was rejected', () => {
    const { db, batchId, ids } = seed('pick');
    for (const id of ids) db.saveReview(id, { ...blank, verdict: 'reject' });
    const b = db.getBatch(batchId)!;
    expect(submitBlockers(b)).toEqual([]);
    expect(exportVerdicts(b).picks).toEqual({ P3: null });
  });
});
