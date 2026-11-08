import { loadConfig } from '../config';
import type { Tx } from '../db';
import { conflict, notFound } from '../errors';
import { iso } from '../time';
import type {
  BatchStatus, Collection, GatewayCoverageClass, LifecycleTransition, Lifecycle, Outcome,
  ReplayInput, ReplayResult, SensorCoverage, SensorType,
} from '../types';
import type { Ctx, Db } from './context';
import { markDirty } from './context';
import { findGateway } from './gatewayStore';
import { wakeSpare } from './gateway';
import { replaySensor } from './sensorEngine';
import { appendTimeline } from './timeline';

/** A sensor as stored: the latest replay result plus the history it came from. */
export interface Sensor {
  id: string;
  type: SensorType;
  registeredAt: number;
  lifecycle: Lifecycle;
  lifecycleReason: string | null;
  lifecycleSince: number;
  collection: Collection;
  coverage: SensorCoverage;
  quietCheckedDays: number;
  samplingCyclesDone: number;
  nextEvaluationAt: number | null;
  history: LifecycleTransition[];
  decommissionedAt: number | null;
  decommissionReason: string | null;
  /** The `now` of the last replay. */
  computedAt: number | null;
}

const SELECT_SENSORS = `
  SELECT id, type, registered_at, lifecycle, lifecycle_reason, lifecycle_since, collection, coverage,
         quiet_checked_days, sampling_cycles_done, next_evaluation_at, history,
         decommissioned_at, decommission_reason, computed_at
    FROM sensors`;

const time = (d: Date | null): number | null => (d === null ? null : d.getTime());

function fromRow(r: any): Sensor {
  return {
    id: r.id,
    type: r.type,
    registeredAt: r.registered_at.getTime(),
    lifecycle: r.lifecycle,
    lifecycleReason: r.lifecycle_reason,
    lifecycleSince: r.lifecycle_since.getTime(),
    collection: r.collection,
    coverage: r.coverage,
    quietCheckedDays: r.quiet_checked_days,
    samplingCyclesDone: r.sampling_cycles_done,
    nextEvaluationAt: time(r.next_evaluation_at),
    history: r.history,
    decommissionedAt: time(r.decommissioned_at),
    decommissionReason: r.decommission_reason,
    computedAt: time(r.computed_at),
  };
}

export async function findSensor(db: Db, id: string): Promise<Sensor | null> {
  const { rows } = await db.query(`${SELECT_SENSORS} WHERE id = $1`, [id]);
  return rows.length === 0 ? null : fromRow(rows[0]);
}

export async function requireSensor(db: Db, id: string): Promise<Sensor> {
  const s = await findSensor(db, id);
  if (!s) throw notFound(`sensor ${id}`);
  return s;
}

export async function listSensors(
  db: Db,
  filters: { lifecycle?: string; coverage?: string; collection?: string },
): Promise<Sensor[]> {
  const { rows } = await db.query(
    `${SELECT_SENSORS}
      WHERE ($1::text IS NULL OR lifecycle = $1)
        AND ($2::text IS NULL OR coverage = $2)
        AND ($3::text IS NULL OR collection = $3)
      ORDER BY id`,
    [filters.lifecycle ?? null, filters.coverage ?? null, filters.collection ?? null],
  );
  return rows.map(fromRow);
}

export async function gatewayIdsOfSensors(db: Db): Promise<Map<string, string[]>> {
  const { rows } = await db.query('SELECT sensor_id, gateway_id FROM sensor_gateways ORDER BY gateway_id');
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.sensor_id, [...(map.get(r.sensor_id) ?? []), r.gateway_id]);
  return map;
}

export async function gatewayIdsOfSensor(db: Db, sensorId: string): Promise<string[]> {
  const { rows } = await db.query('SELECT gateway_id FROM sensor_gateways WHERE sensor_id = $1 ORDER BY gateway_id', [sensorId]);
  return rows.map((r) => r.gateway_id as string);
}

/** The API shape of a sensor (brief) plus `gateway_ids` (console API). */
export function sensorJson(s: Sensor, gatewayIds: string[]) {
  return {
    sensor_id: s.id,
    type: s.type,
    lifecycle: s.lifecycle,
    lifecycle_reason: s.lifecycleReason,
    lifecycle_since: iso(s.lifecycleSince),
    collection: s.collection,
    coverage: s.coverage,
    quiet_checked_days: s.quietCheckedDays,
    sampling_cycles_done: s.samplingCyclesDone,
    next_evaluation_at: iso(s.nextEvaluationAt),
    gateway_ids: gatewayIds,
  };
}

// ---------------------------------------------------------------------------
// Operator actions on sensors
// ---------------------------------------------------------------------------

/** Register a sensor as pending with no coverage. False if the id is taken. */
export async function registerSensor(ctx: Ctx, id: string, type: SensorType): Promise<boolean> {
  const { rowCount } = await ctx.tx.query(
    `INSERT INTO sensors (id, type, registered_at, lifecycle, lifecycle_since, collection, coverage)
     VALUES ($1, $2, $3, 'pending', $3, 'not_checked', 'none')
     ON CONFLICT (id) DO NOTHING`,
    [id, type, iso(ctx.now)],
  );
  return rowCount === 1;
}

/**
 * Replace the set of gateways covering a sensor (at server time). Unknown gateway
 * 404, retired gateway 409. A spare gateway that gets a sensor becomes new.
 */
export async function replaceCoverage(ctx: Ctx, sensorId: string, requestedIds: string[]): Promise<void> {
  const sensor = await requireSensor(ctx.tx, sensorId);
  if (sensor.decommissionedAt !== null) throw conflict('illegal_action', 'sensor is decommissioned');

  const gatewayIds = [...new Set(requestedIds)].sort();
  const gateways = [];
  for (const id of gatewayIds) {
    const g = await findGateway(ctx.tx, id);
    if (!g) throw notFound(`gateway ${id}`);
    gateways.push(g);
  }
  const retired = gateways.find((g) => g.status === 'retired');
  if (retired) throw conflict('gateway_retired', `gateway ${retired.id} is retired`);

  if (JSON.stringify(gatewayIds) === JSON.stringify(await gatewayIdsOfSensor(ctx.tx, sensorId))) return;

  await ctx.tx.query('DELETE FROM sensor_gateways WHERE sensor_id = $1', [sensorId]);
  await ctx.tx.query(
    'INSERT INTO sensor_gateways (sensor_id, gateway_id) SELECT $1, unnest($2::text[])',
    [sensorId, gatewayIds],
  );
  await ctx.tx.query(
    'INSERT INTO sensor_assignment_log (sensor_id, effective_at, gateway_ids) VALUES ($1, $2, $3)',
    [sensorId, iso(ctx.now), gatewayIds],
  );
  for (const g of gateways) await wakeSpare(ctx, g);
  markDirty(ctx, [sensorId]);
}

/** Terminal. Any later action on the sensor is 409. */
export async function decommissionSensor(ctx: Ctx, sensorId: string, reason: string): Promise<void> {
  const sensor = await requireSensor(ctx.tx, sensorId);
  if (sensor.decommissionedAt !== null) throw conflict('illegal_action', 'sensor is already decommissioned');
  await ctx.tx.query('UPDATE sensors SET decommissioned_at = $2, decommission_reason = $3 WHERE id = $1', [
    sensorId, iso(ctx.now), reason,
  ]);
  markDirty(ctx, [sensorId]);
}

// ---------------------------------------------------------------------------
// Recompute: replay the sensor and record what changed (DESIGN §8)
// ---------------------------------------------------------------------------

/** Recompute every sensor the operation touched. */
export async function recomputeDirty(ctx: Ctx): Promise<void> {
  const ids = [...ctx.dirtySensors];
  ctx.dirtySensors.clear();
  for (const id of ids) await recomputeSensor(ctx.tx, id, ctx.now, ctx.evidenceIds);
}

/**
 * Replay the sensor from all stored evidence up to `now`, compare the result with the
 * history we hold, record the difference on the timeline and save the projection.
 * `causeIds` are the evidence ids that triggered this recompute.
 */
export async function recomputeSensor(tx: Tx, sensorId: string, now: number, causeIds: string[]): Promise<void> {
  const sensor = await requireSensor(tx, sensorId);
  if (sensor.lifecycle === 'decommissioned') return; // frozen
  // Background items run at their due time, which can be a moment before a request
  // already replayed this sensor. Replaying to an earlier `now` would look like a
  // shorter history (a false correction), so never go back.
  const at = Math.max(now, sensor.computedAt ?? now);
  const input = await loadReplayInput(tx, sensor, at);
  const result = replaySensor(input);
  result.nextCheckAt = earliest(result.nextCheckAt, nextGatewayChangeAfter(input));
  await recordLifecycle(tx, sensor, result, causeIds);
  await recordAxisChange(tx, sensor, 'coverage', sensor.coverage, result.coverage, result.coverageSince, []);
  await recordAxisChange(tx, sensor, 'collection', sensor.collection, result.collection, result.collectionSince, causeIds);
  await saveProjection(tx, sensorId, result, at);
}

/** A gateway change can be effective slightly in the future (device clocks run ahead by up to 5 min). */
function nextGatewayChangeAfter(input: ReplayInput): number | null {
  const future = Object.values(input.gatewayLogs).flatMap((log) => log.map((row) => row.effectiveAt)).filter((t) => t > input.now);
  return future.length === 0 ? null : Math.min(...future);
}

const earliest = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

async function loadReplayInput(tx: Tx, sensor: Sensor, now: number): Promise<ReplayInput> {
  const assignments = (
    await tx.query('SELECT effective_at, gateway_ids FROM sensor_assignment_log WHERE sensor_id = $1 ORDER BY effective_at, id', [sensor.id])
  ).rows.map((r) => ({ effectiveAt: r.effective_at.getTime() as number, gatewayIds: r.gateway_ids as string[] }));

  const gatewayIds = [...new Set(assignments.flatMap((a) => a.gatewayIds))];
  const gatewayLogs: ReplayInput['gatewayLogs'] = Object.fromEntries(gatewayIds.map((id) => [id, []]));
  const logRows = await tx.query(
    `SELECT gateway_id, effective_at, coverage_class FROM gateway_state_log
      WHERE gateway_id = ANY($1) ORDER BY effective_at, id`,
    [gatewayIds],
  );
  for (const r of logRows.rows) {
    gatewayLogs[r.gateway_id].push({
      effectiveAt: r.effective_at.getTime(),
      coverageClass: r.coverage_class as GatewayCoverageClass,
    });
  }

  const outcomes = (
    await tx.query('SELECT gateway_id, cycle_id, finished_at, outcome, batch_id FROM cycle_results WHERE sensor_id = $1', [sensor.id])
  ).rows.map((r) => ({
    gatewayId: r.gateway_id as string,
    cycleId: r.cycle_id as string,
    finishedAt: r.finished_at.getTime() as number,
    outcome: r.outcome as Outcome,
    batchId: r.batch_id as string | null,
  }));

  const readings = (
    await tx.query('SELECT reading_id, batch_id, gateway_id, taken_at FROM readings WHERE sensor_id = $1', [sensor.id])
  ).rows.map((r) => ({
    readingId: r.reading_id as string,
    batchId: r.batch_id as string,
    gatewayId: r.gateway_id as string,
    takenAt: r.taken_at.getTime() as number,
  }));

  const batchIds = [...new Set([...outcomes.flatMap((o) => (o.batchId ? [o.batchId] : [])), ...readings.map((r) => r.batchId)])];
  const batches: ReplayInput['batches'] = {};
  const batchRows = await tx.query('SELECT id, status, gateway_id FROM batches WHERE id = ANY($1)', [batchIds]);
  for (const r of batchRows.rows) batches[r.id] = { status: r.status as BatchStatus, gatewayId: r.gateway_id };

  return {
    sensor: { id: sensor.id, type: sensor.type, registeredAt: sensor.registeredAt },
    now,
    assignments,
    gatewayLogs,
    outcomes,
    batches,
    readings,
    decommission:
      sensor.decommissionedAt === null ? null : { at: sensor.decommissionedAt, reason: sensor.decommissionReason ?? '' },
    config: await loadConfig(tx),
  };
}

const sameTransition = (a: LifecycleTransition, b: LifecycleTransition): boolean =>
  a.from === b.from && a.to === b.to && a.reason === b.reason && a.effectiveAt === b.effectiveAt && a.rule === b.rule;

/**
 * Compare the recomputed history (H') with the stored one (H).
 * Same: record nothing. H is a prefix of H': normal progress, one entry per new
 * transition. Anything else: one correction entry; old entries are never touched.
 */
async function recordLifecycle(tx: Tx, sensor: Sensor, result: ReplayResult, causeIds: string[]): Promise<void> {
  const before = sensor.history;
  const after = result.transitions;
  let k = 0;
  while (k < before.length && k < after.length && sameTransition(before[k], after[k])) k++;
  if (k === before.length && k === after.length) return;

  if (k === before.length) {
    for (const t of after.slice(k)) await appendTransition(tx, sensor.id, t);
    return;
  }
  const firstDifference = Math.min(before[k].effectiveAt, after[k]?.effectiveAt ?? Infinity);
  await appendTimeline(tx, {
    entityType: 'sensor', entityId: sensor.id, kind: 'correction', axis: 'lifecycle',
    from: sensor.lifecycle, to: result.lifecycle, effectiveAt: firstDifference,
    rule: 'late_data_correction', evidenceIds: causeIds,
    detail: { replaced: before.slice(k).map(transitionJson), transitions: after.slice(k).map(transitionJson) },
  });
}

const transitionJson = (t: LifecycleTransition) => ({
  from: t.from, to: t.to, reason: t.reason, effective_at: iso(t.effectiveAt), rule: t.rule, evidence_ids: t.evidenceIds,
});

async function appendTransition(tx: Tx, sensorId: string, t: LifecycleTransition): Promise<void> {
  await appendTimeline(tx, {
    entityType: 'sensor', entityId: sensorId,
    kind: t.to === 'decommissioned' ? 'action' : 'transition',
    axis: 'lifecycle', from: t.from, to: t.to, effectiveAt: t.effectiveAt, rule: t.rule,
    evidenceIds: t.evidenceIds, detail: t.reason === null ? undefined : { reason: t.reason },
  });
}

/** Coverage and collection are derived; a change of either is one transition entry. */
async function recordAxisChange(
  tx: Tx, sensor: Sensor, axis: 'coverage' | 'collection', before: string, after: string, since: number, evidenceIds: string[],
): Promise<void> {
  if (before === after) return;
  await appendTimeline(tx, {
    entityType: 'sensor', entityId: sensor.id, kind: 'transition', axis, from: before, to: after,
    effectiveAt: since, rule: `${axis}_derived`, evidenceIds,
  });
}

async function saveProjection(tx: Tx, sensorId: string, r: ReplayResult, computedAt: number): Promise<void> {
  await tx.query(
    `UPDATE sensors SET
       lifecycle = $2, lifecycle_reason = $3, lifecycle_since = $4,
       collection = $5, collection_since = $6, coverage = $7, coverage_since = $8,
       quiet_checked_days = $9, sampling_cycles_done = $10,
       next_evaluation_at = $11, next_check_at = $12, history = $13::jsonb, computed_at = $14
     WHERE id = $1`,
    [
      sensorId, r.lifecycle, r.lifecycleReason, iso(r.lifecycleSince),
      r.collection, iso(r.collectionSince), r.coverage, iso(r.coverageSince),
      r.quietCheckedDays, r.samplingCyclesDone,
      iso(r.nextEvaluationAt), iso(r.nextCheckAt), JSON.stringify(r.transitions), iso(computedAt),
    ],
  );
}
