// Read-only helpers for the sensor engine (see docs/DESIGN.md section 7).
// Everything here is pure: it answers questions about the evidence as known at `now`.

import { settingsAt } from '../config';
import { DAY, dayStart } from '../time';
import type {
  Collection, GatewayCoverageClass, Outcome, ReplayInput, SensorCoverage,
} from '../types';

/** Brief, "Latest collection": only cycles that finished within the last 24 hours count. */
export const COLLECTION_WINDOW_MS = DAY;

const COVERAGE_ORDER: GatewayCoverageClass[] = ['available', 'stopped', 'recoverable'];
const COLLECTION_PRECEDENCE: Outcome[] = ['readings', 'no_readings', 'could_not_read', 'timed_out'];

/** A cycle outcome after batch resolution (brief, "Sensor days": Unresolved). */
export interface ResolvedOutcome {
  gatewayId: string;
  finishedAt: number;
  /** `readings` becomes `could_not_read` when its batch is quarantined or never arrived. */
  value: Outcome;
  /** A `readings` outcome whose batch is neither resolved nor past its deadline. */
  unresolved: boolean;
  /** When a not-yet-arrived batch will be given up on; null otherwise. */
  deadlineAt: number | null;
}

/** One sensor-wide fact used by the "latest collection" rule. */
export interface CollectionEvidence {
  gatewayId: string;
  at: number;
  value: Outcome;
}

export type DayClass = 'reading' | 'unresolved' | 'quiet' | 'unchecked';

export interface Ctx {
  input: ReplayInput;
  now: number;
  assignments: ReplayInput['assignments'];
  logs: ReplayInput['gatewayLogs'];
  readings: ReplayInput['readings'];
  outcomes: ResolvedOutcome[];
  collectionEvidence: CollectionEvidence[];
  readingDays: Set<number>;
  unresolvedDays: Set<number>;
  quietDays: Set<number>;
  /** Sorted finished_at of no_readings outcomes from a gateway that was available at that time. */
  checkTimes: number[];
  coverageChanges: { at: number; coverage: SensorCoverage }[];
}

const byTime = <T extends { effectiveAt: number }>(a: T, b: T) => a.effectiveAt - b.effectiveAt;

export function buildContext(input: ReplayInput): Ctx {
  const logs: Ctx['logs'] = {};
  for (const [g, rows] of Object.entries(input.gatewayLogs)) logs[g] = [...rows].sort(byTime);
  const ctx: Ctx = {
    input,
    now: input.now,
    assignments: [...input.assignments].sort(byTime),
    logs,
    readings: [...input.readings].sort(
      (a, b) => a.takenAt - b.takenAt || (a.readingId < b.readingId ? -1 : a.readingId > b.readingId ? 1 : 0),
    ),
    outcomes: [],
    collectionEvidence: [],
    readingDays: new Set(),
    unresolvedDays: new Set(),
    quietDays: new Set(),
    checkTimes: [],
    coverageChanges: [],
  };
  ctx.outcomes = resolveOutcomes(ctx);
  ctx.collectionEvidence = buildCollectionEvidence(ctx);
  for (const r of ctx.readings) ctx.readingDays.add(dayStart(r.takenAt));
  for (const o of ctx.outcomes) {
    if (o.unresolved) ctx.unresolvedDays.add(dayStart(o.finishedAt));
    if (isCheck(ctx, o)) {
      ctx.quietDays.add(dayStart(o.finishedAt));
      ctx.checkTimes.push(o.finishedAt);
    }
  }
  ctx.checkTimes.sort((a, b) => a - b);
  ctx.coverageChanges = buildCoverageChanges(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Class of gateway `g` at time t: the last log row at or before t; `dead` before the first. */
export function gatewayClassAt(ctx: Ctx, g: string, t: number): GatewayCoverageClass {
  const rows = ctx.logs[g];
  let cls: GatewayCoverageClass = 'dead';
  if (!rows) return cls;
  for (const row of rows) {
    if (row.effectiveAt <= t) cls = row.coverageClass;
    else break;
  }
  return cls;
}

export function assignedAt(ctx: Ctx, t: number): string[] {
  let ids: string[] = [];
  for (const a of ctx.assignments) {
    if (a.effectiveAt <= t) ids = a.gatewayIds;
    else break;
  }
  return ids;
}

/** Brief, "Coverage": the best class among the covering gateways; none if all dead or unassigned. */
export function coverageAt(ctx: Ctx, t: number): SensorCoverage {
  const classes = assignedAt(ctx, t).map((g) => gatewayClassAt(ctx, g, t));
  for (const c of COVERAGE_ORDER) if (classes.includes(c)) return c as SensorCoverage;
  return 'none';
}

/** Gateways that appear in any assignment: only these can affect this sensor. */
function relevantGateways(ctx: Ctx): string[] {
  return [...new Set(ctx.assignments.flatMap((a) => a.gatewayIds))];
}

function buildCoverageChanges(ctx: Ctx): Ctx['coverageChanges'] {
  const times = new Set<number>(ctx.assignments.map((a) => a.effectiveAt));
  for (const g of relevantGateways(ctx)) for (const row of ctx.logs[g] ?? []) times.add(row.effectiveAt);
  const changes: Ctx['coverageChanges'] = [];
  let prev: SensorCoverage = 'none';
  for (const at of [...times].sort((a, b) => a - b)) {
    const coverage = coverageAt(ctx, at);
    if (coverage !== prev) changes.push({ at, coverage });
    prev = coverage;
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Outcomes and sensor days
// ---------------------------------------------------------------------------

/**
 * Brief, "Sensor days": a readings outcome resolves when its batch ends processed,
 * partially_processed or quarantined, or when the batch deadline passes after finished_at
 * without the batch arriving. A quarantined or missing batch turns it into could_not_read.
 */
function resolveOutcomes(ctx: Ctx): ResolvedOutcome[] {
  const { input, now } = ctx;
  return input.outcomes.map((o) => {
    const base = { gatewayId: o.gatewayId, finishedAt: o.finishedAt, deadlineAt: null as number | null };
    if (o.outcome !== 'readings') return { ...base, value: o.outcome, unresolved: false };
    const batch = o.batchId === null ? undefined : input.batches[o.batchId];
    if (batch) {
      if (batch.status === 'processed' || batch.status === 'partially_processed') {
        return { ...base, value: 'readings', unresolved: false };
      }
      if (batch.status === 'quarantined') return { ...base, value: 'could_not_read', unresolved: false };
      return { ...base, value: 'readings', unresolved: true }; // received / retrying
    }
    const deadlineAt = o.finishedAt + settingsAt(input.config, o.finishedAt).batchDeadlineMs;
    if (now >= deadlineAt) return { ...base, value: 'could_not_read', unresolved: false };
    return { ...base, value: 'readings', unresolved: true, deadlineAt };
  });
}

/** A no_readings outcome from a gateway that was available at that time proves a check. */
function isCheck(ctx: Ctx, o: ResolvedOutcome): boolean {
  return o.value === 'no_readings' && gatewayClassAt(ctx, o.gatewayId, o.finishedAt) === 'available';
}

/** Brief, "Sensor days": first match wins. `day` is the 00:00 UTC start of the day. */
export function classifyDay(ctx: Ctx, day: number): DayClass {
  if (ctx.readingDays.has(day)) return 'reading';
  if (ctx.unresolvedDays.has(day)) return 'unresolved';
  if (ctx.quietDays.has(day)) return 'quiet';
  return 'unchecked';
}

/** Is there a proving no_readings outcome with finished_at in [start, end)? */
export function hasCheckBetween(ctx: Ctx, start: number, end: number): boolean {
  return ctx.checkTimes.some((t) => t >= start && t < end);
}

// ---------------------------------------------------------------------------
// Latest collection
// ---------------------------------------------------------------------------

/**
 * Every outcome that can feed the collection: the cycle outcomes (an unresolved readings
 * outcome still counts as readings), plus each accepted reading from a batch that no cycle
 * mentions, as a readings outcome from its gateway timed at taken_at.
 */
function buildCollectionEvidence(ctx: Ctx): CollectionEvidence[] {
  const mentioned = new Set(ctx.input.outcomes.map((o) => o.batchId).filter((b): b is string => b !== null));
  const evidence: CollectionEvidence[] = ctx.outcomes.map((o) => ({
    gatewayId: o.gatewayId, at: o.finishedAt, value: o.value,
  }));
  for (const r of ctx.readings) {
    if (!mentioned.has(r.batchId)) evidence.push({ gatewayId: r.gatewayId, at: r.takenAt, value: 'readings' });
  }
  return evidence;
}

const precedence = (v: Outcome) => COLLECTION_PRECEDENCE.indexOf(v);

/** The outcome each available, assigned gateway currently contributes (24h freshness applied). */
function freshOutcomesAt(ctx: Ctx, t: number): CollectionEvidence[] {
  const fresh: CollectionEvidence[] = [];
  for (const g of assignedAt(ctx, t)) {
    if (gatewayClassAt(ctx, g, t) !== 'available') continue;
    let latest: CollectionEvidence | null = null;
    for (const e of ctx.collectionEvidence) {
      if (e.gatewayId !== g || e.at > t) continue;
      if (!latest || e.at > latest.at || (e.at === latest.at && precedence(e.value) < precedence(latest.value))) {
        latest = e;
      }
    }
    if (latest && t - latest.at < COLLECTION_WINDOW_MS) fresh.push(latest);
  }
  return fresh;
}

/** Brief, "Latest collection". */
export function collectionAt(ctx: Ctx, t: number): Collection {
  const fresh = freshOutcomesAt(ctx, t);
  if (fresh.length > 0) {
    return fresh.reduce((best, e) => (precedence(e.value) < precedence(best.value) ? e : best)).value;
  }
  return coverageAt(ctx, t) === 'stopped' ? 'collection_stopped' : 'not_checked';
}

/** Start of the unbroken stretch, ending at `now`, in which the collection had its current value. */
export function collectionSince(ctx: Ctx, registeredAt: number): number {
  const current = collectionAt(ctx, ctx.now);
  const points = new Set<number>(ctx.assignments.map((a) => a.effectiveAt));
  for (const g of relevantGateways(ctx)) for (const row of ctx.logs[g] ?? []) points.add(row.effectiveAt);
  for (const e of ctx.collectionEvidence) {
    points.add(e.at);
    points.add(e.at + COLLECTION_WINDOW_MS);
  }
  const candidates = [...points].filter((p) => p <= ctx.now).sort((a, b) => b - a);
  for (const p of candidates) {
    if (collectionAt(ctx, p - 1) !== current) return p;
  }
  return registeredAt;
}

// ---------------------------------------------------------------------------
// Next check
// ---------------------------------------------------------------------------

/**
 * Times after `now` at which time alone could change the answer (besides the timer end,
 * which the caller adds): unresolved batch deadlines, expiry of outcomes that count now,
 * and evidence dated slightly in the future.
 */
export function timeDrivenChecksAfterNow(ctx: Ctx): number[] {
  const { now } = ctx;
  const times: number[] = [];
  for (const o of ctx.outcomes) if (o.deadlineAt !== null && o.deadlineAt > now) times.push(o.deadlineAt);
  for (const e of freshOutcomesAt(ctx, now)) times.push(e.at + COLLECTION_WINDOW_MS);
  for (const e of ctx.collectionEvidence) if (e.at > now) times.push(e.at);
  for (const r of ctx.readings) if (r.takenAt > now) times.push(r.takenAt);
  return times.filter((t) => t > now);
}
