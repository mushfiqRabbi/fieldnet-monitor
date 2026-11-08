import { pool } from '../db';
import { conflict } from '../errors';
import { iso, MINUTE, parseIso } from '../time';
import { BatchStatus, SensorType, UNIT_BY_TYPE } from '../types';
import { flagReadingsInStopPeriods } from './commands';
import { Ctx, markDirty } from './context';
import { applyQualifyingEvidence } from './gateway';
import { findGateway, saveGateway } from './gatewayStore';
import { MAX_CLOCK_SKEW } from './validation';
import { appendTimeline } from './timeline';

/** The 5th failed attempt quarantines the batch (brief: Batch processing). */
const MAX_ATTEMPTS = 5;

interface BatchRow {
  id: string;
  gatewayId: string;
  sensorId: string;
  readings: unknown[];
  receivedAt: number;
  status: BatchStatus;
  attempts: number;
}

/**
 * PUT /gw/v1/batches/{id}: just store it, so we can answer fast. The unique id makes
 * a repeat safe: same gateway and body -> not created; anything else -> 409.
 */
export async function receiveBatch(
  gatewayId: string, batchId: string, body: { sensor_id: string; readings: unknown[] }, hash: string, receivedAt: number,
): Promise<{ created: boolean; processing: BatchStatus }> {
  const inserted = await pool.query(
    `INSERT INTO batches (id, gateway_id, sensor_id, body, body_hash, received_at, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'received')
     ON CONFLICT (id) DO NOTHING`,
    [batchId, gatewayId, body.sensor_id, JSON.stringify(body), hash, iso(receivedAt)],
  );
  if (inserted.rowCount === 1) return { created: true, processing: 'received' };
  const { rows } = await pool.query('SELECT gateway_id, body_hash, status FROM batches WHERE id = $1', [batchId]);
  if (rows[0].gateway_id !== gatewayId || rows[0].body_hash !== hash) {
    throw conflict('batch_conflict', `batch ${batchId} already exists with a different body or gateway`);
  }
  return { created: false, processing: rows[0].status };
}

async function loadBatch(ctx: Ctx, id: string): Promise<BatchRow | null> {
  const { rows } = await ctx.tx.query(
    'SELECT id, gateway_id, sensor_id, body, received_at, status, attempts FROM batches WHERE id = $1',
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id, gatewayId: r.gateway_id, sensorId: r.sensor_id, readings: r.body.readings,
    receivedAt: r.received_at.getTime(), status: r.status, attempts: r.attempts,
  };
}

/** The test hook: the next n processing attempts fail. */
async function consumeFault(ctx: Ctx): Promise<boolean> {
  const { rows } = await ctx.tx.query("SELECT value FROM system_state WHERE key = 'faults'");
  const left = rows.length === 0 ? 0 : Number(rows[0].value);
  if (left <= 0) return false;
  await ctx.tx.query("UPDATE system_state SET value = $1::jsonb WHERE key = 'faults'", [JSON.stringify(left - 1)]);
  return true;
}

/**
 * One processing attempt at ctx.now (the batch's due time). Everything below runs in
 * the caller's transaction, so a failed or retried attempt never leaves readings behind.
 */
export async function processBatch(ctx: Ctx, batchId: string): Promise<void> {
  const batch = await loadBatch(ctx, batchId);
  if (!batch || (batch.status !== 'received' && batch.status !== 'retrying')) return;
  if (await consumeFault(ctx)) return recordFailedAttempt(ctx, batch);

  const sensor = await ctx.tx.query('SELECT type FROM sensors WHERE id = $1', [batch.sensorId]);
  if (sensor.rows.length === 0) return quarantineAll(ctx, batch, 'unknown_sensor');
  const type = sensor.rows[0].type as SensorType;

  const verdicts = batch.readings.map((raw) => judgeReading(raw, type, batch.receivedAt));
  const accepted: Accepted[] = [];
  const quarantined: { readingId: string | null; reason: string }[] = [];
  let ignoredDuplicates = 0;

  const known = await storedReadings(ctx, verdicts.flatMap((v) => (v.ok ? [v.reading.readingId] : [])));
  for (const v of verdicts) {
    if (!v.ok) {
      quarantined.push({ readingId: v.readingId, reason: v.reason });
      continue;
    }
    // Reading ids are globally unique: the first version wins (also inside one batch).
    const first = known.get(v.reading.readingId) ?? accepted.find((a) => a.readingId === v.reading.readingId);
    if (!first) accepted.push(v.reading);
    else if (sameContent(first, v.reading, batch.sensorId)) ignoredDuplicates++;
    else quarantined.push({ readingId: v.reading.readingId, reason: 'conflicting_duplicate' });
  }

  const status: BatchStatus =
    quarantined.length === 0 ? 'processed'
    : accepted.length + ignoredDuplicates === 0 ? 'quarantined'
    : 'partially_processed';

  await storeReadings(ctx, batch, accepted);
  await storeQuarantined(ctx, batch.id, quarantined);
  await finishBatch(ctx, batch, status, accepted.length, status === 'quarantined' ? 'all_readings_invalid' : null);
  if (accepted.length > 0) await acceptEvidence(ctx, batch, accepted);
}

/** An attempt that failed: retry after 2^(k-1) minutes, or quarantine after the 5th. */
export async function recordFailedAttempt(ctx: Ctx, batch: BatchRow): Promise<void> {
  const attempts = batch.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return quarantineAll(ctx, batch, 'processing_failed');
  const nextAttemptAt = ctx.now + 2 ** (attempts - 1) * MINUTE;
  await ctx.tx.query(
    "UPDATE batches SET status = 'retrying', attempts = $2, next_attempt_at = $3 WHERE id = $1",
    [batch.id, attempts, iso(nextAttemptAt)],
  );
  await appendBatchEntry(ctx, batch, 'retrying', 'processing_attempt_failed');
}

/** Used by the due-work loop when processing threw. */
export async function failBatchAttempt(ctx: Ctx, batchId: string): Promise<void> {
  const batch = await loadBatch(ctx, batchId);
  if (batch && (batch.status === 'received' || batch.status === 'retrying')) await recordFailedAttempt(ctx, batch);
}

async function quarantineAll(ctx: Ctx, batch: BatchRow, reason: string): Promise<void> {
  const rows = batch.readings.map((raw) => ({ readingId: readingIdOf(raw), reason }));
  await storeQuarantined(ctx, batch.id, rows);
  await finishBatch(ctx, batch, 'quarantined', 0, reason, batch.attempts + 1);
}

async function finishBatch(
  ctx: Ctx, batch: BatchRow, status: BatchStatus, acceptedCount: number, reason: string | null,
  attempts = batch.attempts + 1,
): Promise<void> {
  await ctx.tx.query(
    `UPDATE batches SET status = $2, attempts = $3, next_attempt_at = NULL, processed_at = $4,
                        accepted_count = $5, quarantine_reason = $6 WHERE id = $1`,
    [batch.id, status, attempts, iso(ctx.now), acceptedCount, reason],
  );
  await appendBatchEntry(ctx, batch, status, reason ?? 'processed');
}

async function appendBatchEntry(ctx: Ctx, batch: BatchRow, to: BatchStatus, rule: string): Promise<void> {
  await appendTimeline(ctx.tx, {
    entityType: 'batch', entityId: batch.id, kind: 'transition', axis: 'processing',
    from: batch.status, to, effectiveAt: ctx.now, rule,
  });
}

// ---------------------------------------------------------------------------
// Judging readings
// ---------------------------------------------------------------------------

interface Accepted {
  readingId: string;
  takenAt: number;
  value: number;
  unit: string;
}

type Verdict = { ok: true; reading: Accepted } | { ok: false; readingId: string | null; reason: string };

const readingIdOf = (raw: unknown): string | null => {
  const id = (raw as Record<string, unknown> | null)?.reading_id;
  return typeof id === 'string' && id !== '' ? id : null;
};

/** Brief: invalid if a field is missing, value is not a number, unit is wrong, or taken_at is > 5 min after receipt. */
function judgeReading(raw: unknown, type: SensorType, receivedAt: number): Verdict {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const readingId = readingIdOf(raw);
  const reject = (reason: string): Verdict => ({ ok: false, readingId, reason });

  const missing = ['reading_id', 'taken_at', 'value', 'unit'].some((f) => r[f] === undefined || r[f] === null);
  if (missing || readingId === null) return reject('missing_field');
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return reject('invalid_value');
  const takenAt = parseIso(r.taken_at);
  if (takenAt === null) return reject('invalid_timestamp');
  if (takenAt > receivedAt + MAX_CLOCK_SKEW) return reject('future_timestamp');
  if (r.unit !== UNIT_BY_TYPE[type]) return reject('wrong_unit');
  return { ok: true, reading: { readingId, takenAt, value: r.value, unit: r.unit } };
}

interface StoredReading extends Accepted {
  sensorId: string;
}

async function storedReadings(ctx: Ctx, ids: string[]): Promise<Map<string, StoredReading>> {
  const { rows } = await ctx.tx.query(
    'SELECT reading_id, sensor_id, taken_at, value, unit FROM readings WHERE reading_id = ANY($1)',
    [ids],
  );
  return new Map(rows.map((r) => [r.reading_id, {
    readingId: r.reading_id, sensorId: r.sensor_id, takenAt: r.taken_at.getTime(), value: r.value, unit: r.unit,
  }]));
}

function sameContent(first: Accepted & { sensorId?: string }, again: Accepted, sensorId: string): boolean {
  return (first.sensorId ?? sensorId) === sensorId && first.takenAt === again.takenAt
    && first.value === again.value && first.unit === again.unit;
}

async function storeReadings(ctx: Ctx, batch: BatchRow, accepted: Accepted[]): Promise<void> {
  if (accepted.length === 0) return;
  await ctx.tx.query(
    `INSERT INTO readings (reading_id, batch_id, gateway_id, sensor_id, taken_at, value, unit, accepted_at)
     SELECT id, $2, $3, $4, taken_at, value, unit, $5
       FROM unnest($1::text[], $6::timestamptz[], $7::double precision[], $8::text[]) AS t(id, taken_at, value, unit)`,
    [
      accepted.map((a) => a.readingId), batch.id, batch.gatewayId, batch.sensorId, iso(ctx.now),
      accepted.map((a) => iso(a.takenAt)), accepted.map((a) => a.value), accepted.map((a) => a.unit),
    ],
  );
}

async function storeQuarantined(ctx: Ctx, batchId: string, rows: { readingId: string | null; reason: string }[]): Promise<void> {
  if (rows.length === 0) return;
  await ctx.tx.query(
    `INSERT INTO quarantined_readings (batch_id, reading_id, reason)
     SELECT $1, id, reason FROM unnest($2::text[], $3::text[]) AS t(id, reason)`,
    [batchId, rows.map((r) => r.readingId), rows.map((r) => r.reason)],
  );
}

/**
 * Accepted readings are qualifying evidence for the gateway (at the latest taken_at),
 * may raise collecting_after_stop, and feed the sensor. Gateway first, then sensor.
 */
async function acceptEvidence(ctx: Ctx, batch: BatchRow, accepted: Accepted[]): Promise<void> {
  ctx.evidenceIds = accepted.map((a) => a.readingId);
  const gateway = await findGateway(ctx.tx, batch.gatewayId);
  if (gateway && gateway.status !== 'retired') {
    await applyQualifyingEvidence(ctx, gateway, Math.max(...accepted.map((a) => a.takenAt)));
    await flagReadingsInStopPeriods(ctx, gateway, accepted.map((a) => ({ id: a.readingId, takenAt: a.takenAt })));
    await saveGateway(ctx.tx, gateway);
  }
  markDirty(ctx, [batch.sensorId]);
}

// ---------------------------------------------------------------------------
// GET /api/v1/batches/{id}
// ---------------------------------------------------------------------------

export async function batchReport(batchId: string) {
  const { rows } = await pool.query('SELECT status, attempts, accepted_count FROM batches WHERE id = $1', [batchId]);
  if (rows.length === 0) return null;
  const quarantined = await pool.query(
    'SELECT reading_id, reason FROM quarantined_readings WHERE batch_id = $1 ORDER BY id',
    [batchId],
  );
  return {
    processing: rows[0].status as BatchStatus,
    attempts: rows[0].attempts as number,
    accepted_count: rows[0].accepted_count as number,
    quarantined: quarantined.rows.map((q) => ({ reading_id: q.reading_id as string | null, reason: q.reason as string })),
  };
}
