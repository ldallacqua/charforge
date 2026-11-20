// SQLite storage (node:sqlite, no native addon). One writer: the server process.

import { DatabaseSync } from 'node:sqlite';
import type {
  Batch, BatchDetail, BatchKind, Character, CharacterDetail, Check, Counts, GateMark, Item, Job, PhaseState, Region, Review,
} from '../shared/types.ts';
import type { RenderProfile, RenderRequest } from '../render/types.ts';
import { PHASES } from '../shared/phases.ts';

const MIGRATIONS = [
  `CREATE TABLE characters (
     id INTEGER PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     cover TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE batches (
     id INTEGER PRIMARY KEY,
     character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
     phase TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('review', 'pick')),
     title TEXT NOT NULL,
     notes TEXT NOT NULL DEFAULT '',
     round INTEGER NOT NULL DEFAULT 1,
     parent_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
     owner_note TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     submitted_at TEXT
   );
   CREATE TABLE items (
     id INTEGER PRIMARY KEY,
     batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     label TEXT NOT NULL,
     grp TEXT NOT NULL DEFAULT '',
     file TEXT NOT NULL,
     thumb TEXT NOT NULL,
     prev_file TEXT,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     has_alpha INTEGER NOT NULL DEFAULT 0,
     source TEXT,
     meta TEXT NOT NULL DEFAULT '{}',
     regions TEXT NOT NULL DEFAULT '[]',
     checks TEXT NOT NULL DEFAULT '[]'
   );
   CREATE INDEX items_batch ON items(batch_id, position);
   CREATE TABLE reviews (
     item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
     verdict TEXT CHECK (verdict IN ('approve', 'reject')),
     reasons TEXT NOT NULL DEFAULT '[]',
     regions TEXT NOT NULL DEFAULT '{}',
     pins TEXT NOT NULL DEFAULT '[]',
     note TEXT NOT NULL DEFAULT '',
     updated_at TEXT NOT NULL
   );`,
  `ALTER TABLE characters ADD COLUMN brief TEXT NOT NULL DEFAULT '';
   ALTER TABLE characters ADD COLUMN profile TEXT NOT NULL DEFAULT '';
   ALTER TABLE characters ADD COLUMN gates TEXT NOT NULL DEFAULT '{}';
   CREATE TABLE jobs (
     id INTEGER PRIMARY KEY,
     character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
     phase TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'review',
     rating TEXT NOT NULL CHECK (rating IN ('sfw', 'nsfw')),
     backend TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     grp TEXT NOT NULL DEFAULT '',
     request TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
     worker TEXT,
     error TEXT,
     batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT
   );
   CREATE INDEX jobs_status ON jobs(status, id);`,
];

export type Db = ReturnType<typeof openDb>;

const now = () => new Date().toISOString();
const json = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);
const fileUrl = (rel: string) => `/files/${rel.split('/').map(encodeURIComponent).join('/')}`;

const EMPTY_REVIEW: Review = { verdict: null, reasons: [], regions: {}, pins: [], note: '', updatedAt: null };

type Row = Record<string, any>;

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = (db.prepare('PRAGMA user_version').get() as Row).user_version as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  // ---------- mapping ----------

  const countsSql = `
    SELECT COUNT(*) AS total,
           SUM(r.verdict = 'approve') AS approved,
           SUM(r.verdict = 'reject') AS rejected
      FROM items i LEFT JOIN reviews r ON r.item_id = i.id
     WHERE i.batch_id = ?`;

  function counts(batchId: number): Counts {
    const r = db.prepare(countsSql).get(batchId) as Row;
    const total = Number(r.total ?? 0);
    const approved = Number(r.approved ?? 0);
    const rejected = Number(r.rejected ?? 0);
    return { total, approved, rejected, pending: total - approved - rejected };
  }

  function toBatch(r: Row): Batch {
    const thumbs = (db.prepare('SELECT thumb FROM items WHERE batch_id = ? ORDER BY position LIMIT 8').all(r.id) as Row[])
      .map((t) => fileUrl(t.thumb));
    return {
      id: r.id, characterId: r.character_id, characterSlug: r.slug, characterName: r.name,
      phase: r.phase, kind: r.kind as BatchKind, title: r.title, notes: r.notes, round: r.round,
      parentId: r.parent_id ?? null, status: r.status, createdAt: r.created_at, submittedAt: r.submitted_at ?? null,
      ownerNote: r.owner_note, counts: counts(r.id), thumbs,
    };
  }

  function toReview(r: Row | undefined): Review {
    if (!r) return { ...EMPTY_REVIEW };
    return {
      verdict: (r.verdict ?? null) as Review['verdict'],
      reasons: json(r.reasons, []), regions: json(r.regions, {}), pins: json(r.pins, []),
      note: r.note ?? '', updatedAt: r.updated_at ?? null,
    };
  }

  function toItem(r: Row): Item {
    return {
      id: r.id, batchId: r.batch_id, position: r.position, label: r.label, group: r.grp,
      url: fileUrl(r.file), thumbUrl: fileUrl(r.thumb), prevUrl: r.prev_file ? fileUrl(r.prev_file) : null,
      width: r.width, height: r.height, hasAlpha: !!r.has_alpha, source: r.source ?? null,
      meta: json(r.meta, {}), regions: json<Region[]>(r.regions, []), checks: json<Check[]>(r.checks, []),
      review: toReview(r.r_item_id ? {
        verdict: r.verdict, reasons: r.reasons, regions: r.r_regions, pins: r.pins, note: r.note, updated_at: r.updated_at,
      } : undefined),
    };
  }

  const batchSelect = `SELECT b.*, c.slug, c.name FROM batches b JOIN characters c ON c.id = b.character_id`;

  /** done: signed off (explicit); waiting: a batch waits for the owner; active: work in progress; idle: not started */
  function phaseStates(characterId: number, gates: Record<string, GateMark>): Record<string, PhaseState> {
    const out: Record<string, PhaseState> = {};
    const rows = db.prepare('SELECT id, phase, status FROM batches WHERE character_id = ? ORDER BY id').all(characterId) as Row[];
    const jobs = db.prepare(`SELECT phase FROM jobs WHERE character_id = ? AND status IN ('queued', 'running')`).all(characterId) as Row[];
    for (const p of PHASES) {
      const mine = rows.filter((r) => r.phase === p.id);
      if (gates[p.id]?.status === 'done') out[p.id] = 'done';
      else if (mine.some((r) => r.status === 'open')) out[p.id] = 'waiting';
      else if (mine.length || jobs.some((j) => j.phase === p.id)) out[p.id] = 'active';
      else out[p.id] = 'idle';
    }
    return out;
  }

  function toCharacter(r: Row): Character {
    const open = (db.prepare(`SELECT COUNT(*) AS n FROM batches WHERE character_id = ? AND status = 'open'`).get(r.id) as Row).n;
    const gates = json<Record<string, GateMark>>(r.gates, {});
    return {
      id: r.id, slug: r.slug, name: r.name, summary: r.summary, brief: r.brief ?? '', coverUrl: r.cover ? fileUrl(r.cover) : null,
      createdAt: r.created_at, openBatches: Number(open), phases: phaseStates(r.id, gates), gates,
      profile: r.profile ? (JSON.parse(r.profile) as RenderProfile) : null,
    };
  }

  function toJob(r: Row): Job {
    return {
      id: r.id, characterSlug: r.slug, phase: r.phase, kind: r.kind, rating: r.rating, backend: r.backend, title: r.title, group: r.grp,
      request: json<RenderRequest>(r.request, { prompt: '', rating: 'sfw' }), status: r.status, worker: r.worker ?? null, error: r.error ?? null,
      batchId: r.batch_id ?? null, createdAt: r.created_at, startedAt: r.started_at ?? null, finishedAt: r.finished_at ?? null,
    };
  }
  const jobSelect = `SELECT j.*, c.slug FROM jobs j JOIN characters c ON c.id = j.character_id`;

  // ---------- queries ----------

  return {
    raw: db,
    tx,

    listCharacters(): Character[] {
      return (db.prepare('SELECT * FROM characters ORDER BY created_at DESC').all() as Row[]).map(toCharacter);
    },

    characterRow(slug: string): Row | undefined {
      return db.prepare('SELECT * FROM characters WHERE slug = ?').get(slug) as Row | undefined;
    },

    getCharacter(slug: string): CharacterDetail | null {
      const r = db.prepare('SELECT * FROM characters WHERE slug = ?').get(slug) as Row | undefined;
      if (!r) return null;
      const batches = (db.prepare(`${batchSelect} WHERE b.character_id = ? ORDER BY b.id DESC`).all(r.id) as Row[]).map(toBatch);
      return { ...toCharacter(r), batches };
    },

    createCharacter(input: { slug: string; name: string; summary?: string; brief?: string; profile?: RenderProfile | null; gates?: Record<string, GateMark> }): Character {
      db.prepare('INSERT INTO characters (slug, name, summary, brief, profile, gates, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.slug, input.name, input.summary ?? '', input.brief ?? '', input.profile ? JSON.stringify(input.profile) : '', JSON.stringify(input.gates ?? {}), now());
      return toCharacter(db.prepare('SELECT * FROM characters WHERE slug = ?').get(input.slug) as Row);
    },

    updateCharacter(slug: string, patch: { name?: string; summary?: string; brief?: string; cover?: string | null; profile?: RenderProfile | null }) {
      const r = db.prepare('SELECT * FROM characters WHERE slug = ?').get(slug) as Row | undefined;
      if (!r) return null;
      db.prepare('UPDATE characters SET name = ?, summary = ?, brief = ?, cover = ?, profile = ? WHERE id = ?')
        .run(patch.name ?? r.name, patch.summary ?? r.summary, patch.brief ?? r.brief, patch.cover === undefined ? r.cover : patch.cover,
          patch.profile === undefined ? r.profile : patch.profile ? JSON.stringify(patch.profile) : '', r.id);
      return toCharacter(db.prepare('SELECT * FROM characters WHERE id = ?').get(r.id) as Row);
    },

    setGate(slug: string, gate: string, mark: GateMark | null) {
      const r = db.prepare('SELECT id, gates FROM characters WHERE slug = ?').get(slug) as Row | undefined;
      if (!r) return null;
      const gates = json<Record<string, GateMark>>(r.gates, {});
      if (mark) gates[gate] = mark;
      else delete gates[gate];
      db.prepare('UPDATE characters SET gates = ? WHERE id = ?').run(JSON.stringify(gates), r.id);
      return gates;
    },

    // ---------- render jobs ----------

    createJob(input: { characterId: number; phase: string; kind: BatchKind; rating: string; backend: string; title: string; group: string; request: RenderRequest }): Job {
      const res = db.prepare(`INSERT INTO jobs (character_id, phase, kind, rating, backend, title, grp, request, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.characterId, input.phase, input.kind, input.rating, input.backend, input.title, input.group, JSON.stringify(input.request), now());
      return toJob(db.prepare(`${jobSelect} WHERE j.id = ?`).get(Number(res.lastInsertRowid)) as Row);
    },

    getJob(id: number): Job | null {
      const r = db.prepare(`${jobSelect} WHERE j.id = ?`).get(id) as Row | undefined;
      return r ? toJob(r) : null;
    },

    listJobs(filter: { slug?: string; active?: boolean } = {}): Job[] {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (filter.slug) { where.push('c.slug = ?'); args.push(filter.slug); }
      if (filter.active) where.push(`j.status IN ('queued', 'running')`);
      const sql = `${jobSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.id DESC LIMIT 100`;
      return (db.prepare(sql).all(...args) as Row[]).map(toJob);
    },

    /** Atomically hand the oldest queued job for one of these backends to a worker. */
    claimJob(backends: string[], worker: string): Job | null {
      if (!backends.length) return null;
      return tx(() => {
        const r = db.prepare(`SELECT id FROM jobs WHERE status = 'queued' AND backend IN (${backends.map(() => '?').join(',')}) ORDER BY id LIMIT 1`).get(...backends) as Row | undefined;
        if (!r) return null;
        db.prepare(`UPDATE jobs SET status = 'running', worker = ?, started_at = ? WHERE id = ?`).run(worker, now(), r.id);
        return toJob(db.prepare(`${jobSelect} WHERE j.id = ?`).get(r.id) as Row);
      });
    },

    finishJob(id: number, result: { batchId?: number; error?: string }) {
      db.prepare(`UPDATE jobs SET status = ?, error = ?, batch_id = ?, finished_at = ? WHERE id = ?`)
        .run(result.error ? 'failed' : 'done', result.error ?? null, result.batchId ?? null, now(), id);
    },

    /** Jobs left running by a worker that died (server restart) go back to the queue. */
    requeueStale(worker: string) {
      db.prepare(`UPDATE jobs SET status = 'queued', worker = NULL, started_at = NULL WHERE status = 'running' AND worker = ?`).run(worker);
    },

    openBatches(): Batch[] {
      return (db.prepare(`${batchSelect} WHERE b.status = 'open' ORDER BY b.id DESC`).all() as Row[]).map(toBatch);
    },

    createBatch(input: { characterId: number; phase: string; kind: BatchKind; title: string; notes: string; parentId: number | null }): number {
      let round = 1;
      if (input.parentId) {
        const p = db.prepare('SELECT round FROM batches WHERE id = ?').get(input.parentId) as Row | undefined;
        if (!p) throw new Error(`parent batch ${input.parentId} not found`);
        round = Number(p.round) + 1;
      }
      const res = db.prepare(`INSERT INTO batches (character_id, phase, kind, title, notes, round, parent_id, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.characterId, input.phase, input.kind, input.title, input.notes, round, input.parentId, now());
      return Number(res.lastInsertRowid);
    },

    addItem(input: {
      batchId: number; position: number; label: string; group: string; file: string; thumb: string; prevFile: string | null;
      width: number; height: number; hasAlpha: boolean; source: string | null; meta: unknown; regions: Region[]; checks: Check[];
    }): number {
      const res = db.prepare(`INSERT INTO items (batch_id, position, label, grp, file, thumb, prev_file, width, height, has_alpha, source, meta, regions, checks)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.batchId, input.position, input.label, input.group, input.file, input.thumb, input.prevFile, input.width, input.height,
          input.hasAlpha ? 1 : 0, input.source, JSON.stringify(input.meta ?? {}), JSON.stringify(input.regions), JSON.stringify(input.checks));
      return Number(res.lastInsertRowid);
    },

    getBatch(id: number): BatchDetail | null {
      const r = db.prepare(`${batchSelect} WHERE b.id = ?`).get(id) as Row | undefined;
      if (!r) return null;
      const items = (db.prepare(`SELECT i.*, r.item_id AS r_item_id, r.verdict, r.reasons, r.regions AS r_regions, r.pins, r.note, r.updated_at
                                   FROM items i LEFT JOIN reviews r ON r.item_id = i.id
                                  WHERE i.batch_id = ? ORDER BY i.position`).all(id) as Row[]).map(toItem);
      return { ...toBatch(r), items };
    },

    batchSummary(id: number): Batch | null {
      const r = db.prepare(`${batchSelect} WHERE b.id = ?`).get(id) as Row | undefined;
      return r ? toBatch(r) : null;
    },

    itemRow(id: number): Row | undefined {
      return db.prepare('SELECT i.*, b.kind, b.status FROM items i JOIN batches b ON b.id = i.batch_id WHERE i.id = ?').get(id) as Row | undefined;
    },

    getReview(itemId: number): Review {
      return toReview(db.prepare('SELECT * FROM reviews WHERE item_id = ?').get(itemId) as Row | undefined);
    },

    saveReview(itemId: number, review: Review) {
      db.prepare(`INSERT INTO reviews (item_id, verdict, reasons, regions, pins, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(item_id) DO UPDATE SET verdict = excluded.verdict, reasons = excluded.reasons, regions = excluded.regions,
                  pins = excluded.pins, note = excluded.note, updated_at = excluded.updated_at`)
        .run(itemId, review.verdict, JSON.stringify(review.reasons), JSON.stringify(review.regions), JSON.stringify(review.pins), review.note, now());
    },

    /** Pick batches: one approved candidate per group. */
    clearOtherPicks(itemId: number) {
      const r = db.prepare('SELECT batch_id, grp FROM items WHERE id = ?').get(itemId) as Row;
      db.prepare(`UPDATE reviews SET verdict = NULL, updated_at = ?
                   WHERE verdict = 'approve' AND item_id IN (SELECT id FROM items WHERE batch_id = ? AND grp = ? AND id != ?)`)
        .run(now(), r.batch_id, r.grp, itemId);
      return (db.prepare('SELECT id FROM items WHERE batch_id = ? AND grp = ? AND id != ?').all(r.batch_id, r.grp, itemId) as Row[]).map((x) => x.id as number);
    },

    setBatchStatus(id: number, status: 'open' | 'submitted', ownerNote?: string) {
      if (status === 'submitted') {
        db.prepare('UPDATE batches SET status = ?, submitted_at = ?, owner_note = ? WHERE id = ?').run(status, now(), ownerNote ?? '', id);
      } else {
        db.prepare('UPDATE batches SET status = ?, submitted_at = NULL WHERE id = ?').run(status, id);
      }
    },
  };
}
