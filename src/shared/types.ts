// Types shared by the server, the web app and the agent CLI.
// Boxes are always in the image's own pixels: [x0, y0, x1, y1].

import type { RenderProfile, RenderRequest } from '../render/types.ts';

export type Box = [number, number, number, number];

export type RegionKind =
  | 'face' | 'eyes' | 'mouth' | 'hair' | 'horns'
  | 'hand' | 'feet' | 'body' | 'outfit' | 'accessory'
  | 'wings' | 'tail' | 'edge' | 'other';

/** A place the agent asks the owner to inspect up close (a loupe). */
export interface Region {
  id: string;
  kind: RegionKind;
  label: string;
  box: Box;
}

/** An automatic check the agent ran before submitting (qa_sprites.py and friends). */
export interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail?: string;
}

/** A spot the owner marked on the image. */
export interface Pin {
  id: string;
  box: Box;
  reason?: string;
  note?: string;
}

export interface RegionMark {
  verdict: 'ok' | 'bad';
  reasons: string[];
}

export type Verdict = 'approve' | 'reject' | null;

export interface Review {
  verdict: Verdict;
  reasons: string[];
  regions: Record<string, RegionMark>;
  pins: Pin[];
  note: string;
  updatedAt: string | null;
}

export type BatchKind = 'review' | 'pick';
export type BatchStatus = 'open' | 'submitted';

export interface Item {
  id: number;
  batchId: number;
  position: number;
  label: string;
  group: string;
  url: string;
  thumbUrl: string;
  prevUrl: string | null;
  width: number;
  height: number;
  hasAlpha: boolean;
  source: string | null;
  meta: Record<string, unknown>;
  regions: Region[];
  checks: Check[];
  review: Review;
}

export interface Counts {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
}

export interface Batch {
  id: number;
  characterId: number;
  characterSlug: string;
  characterName: string;
  phase: string;
  kind: BatchKind;
  title: string;
  notes: string;
  round: number;
  parentId: number | null;
  status: BatchStatus;
  createdAt: string;
  submittedAt: string | null;
  ownerNote: string;
  counts: Counts;
  thumbs: string[];
}

export interface BatchDetail extends Batch {
  items: Item[];
}

export interface GateMark {
  status: 'done';
  at: string;
  by: 'owner' | 'agent';
  note?: string;
}

export interface Character {
  id: number;
  slug: string;
  name: string;
  summary: string;
  /** what the owner asked for, in their words: the source of truth for discovery */
  brief: string;
  coverUrl: string | null;
  createdAt: string;
  openBatches: number;
  /** phase id -> state (done only when the gate was signed off) */
  phases: Record<string, PhaseState>;
  gates: Record<string, GateMark>;
  /** which backend renders SFW and NSFW for this character */
  profile: RenderProfile | null;
}

export interface Job {
  id: number;
  characterSlug: string;
  phase: string;
  kind: BatchKind;
  rating: 'sfw' | 'nsfw';
  backend: string;
  title: string;
  group: string;
  request: RenderRequest;
  status: 'queued' | 'running' | 'done' | 'failed';
  worker: string | null;
  error: string | null;
  batchId: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface NextStep {
  gate: string | null;
  state: 'start' | 'rendering' | 'owner' | 'fix' | 'signoff' | 'done';
  /** what the owner has to do now, in Portuguese (null: nothing) */
  owner: string | null;
  /** what the agent has to do now, in English */
  agent: string | null;
  commands: string[];
  batchId?: number;
}

export type PhaseState = 'done' | 'active' | 'waiting' | 'idle';

export interface CharacterDetail extends Character {
  batches: Batch[];
}

/** What the agent sends with `forge submit` (file fields are multipart field names). */
export interface Manifest {
  character: string;
  /** set by the server when a render job produced the batch */
  jobId?: number;
  phase: string;
  kind?: BatchKind;
  title: string;
  notes?: string;
  parentId?: number | null;
  items: ManifestItem[];
}

export interface ManifestItem {
  file: string;
  previous?: string;
  label?: string;
  group?: string;
  source?: string;
  meta?: Record<string, unknown>;
  regions?: Array<Omit<Region, 'id'> & { id?: string }>;
  checks?: Check[];
}

export type ServerEvent =
  | { type: 'batch.created'; batch: Batch }
  | { type: 'batch.updated'; batch: Batch }
  | { type: 'review.updated'; itemId: number; batchId: number; review: Review }
  | { type: 'character.updated'; slug: string }
  | { type: 'job.updated'; job: Job };
