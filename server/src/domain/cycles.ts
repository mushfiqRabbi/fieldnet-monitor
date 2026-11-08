import { conflict } from '../errors';
import { iso } from '../time';
import type { Outcome } from '../types';
import type { Ctx } from './context';
import { markDirty } from './context';
import { applyQualifyingEvidence, recordAuthFailure } from './gateway';
import { Gateway, saveGateway } from './gatewayStore';

export type ApiOutcome = 'readings' | 'no_readings' | 'could_not_read' | 'timeout';

export interface CycleReport {
  cycleId: string;
  startedAt: number;
  finishedAt: number;
  session: 'ok' | 'auth_failed';
  results: { sensorId: string; outcome: ApiOutcome; batchId: string | null }[];
}

/** What is stored for a result: `timeout` is `timed_out`; auth_failed records could_not_read. */
function storedOutcome(report: CycleReport, outcome: ApiOutcome): Outcome {
  if (report.session === 'auth_failed') return 'could_not_read';
  return outcome === 'timeout' ? 'timed_out' : outcome;
}

/**
 * Store a cycle report. Order (brief): update the gateway, then coverage (inside
 * the gateway change), then the sensors (recomputed by the caller afterwards).
 * Identical repeat: no change. Same cycle_id, other body: 409 cycle_conflict.
 */
export async function ingestCycle(
  ctx: Ctx, g: Gateway, report: CycleReport, hash: string,
): Promise<{ duplicate: boolean; ignored: string[] }> {
  const existing = await ctx.tx.query(
    'SELECT body_hash, ignored FROM cycles WHERE gateway_id = $1 AND cycle_id = $2',
    [g.id, report.cycleId],
  );
  if (existing.rows.length > 0) {
    if (existing.rows[0].body_hash !== hash) {
      throw conflict('cycle_conflict', `cycle ${report.cycleId} was already reported with a different body`);
    }
    return { duplicate: true, ignored: existing.rows[0].ignored };
  }

  const covered = await coveredSensorIds(ctx, g.id, report.results.map((r) => r.sensorId));
  const results = report.results.filter((r) => covered.has(r.sensorId));
  const ignored = [...new Set(report.results.map((r) => r.sensorId).filter((id) => !covered.has(id)))];

  ctx.evidenceIds = [report.cycleId];
  if (report.session === 'auth_failed') {
    await recordAuthFailure(ctx, g, report.finishedAt);
  } else if (results.some((r) => r.outcome === 'readings' || r.outcome === 'no_readings')) {
    await applyQualifyingEvidence(ctx, g, report.finishedAt);
  }
  await saveGateway(ctx.tx, g);

  await ctx.tx.query(
    `INSERT INTO cycles (gateway_id, cycle_id, body_hash, started_at, finished_at, session, received_at, ignored)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [g.id, report.cycleId, hash, iso(report.startedAt), iso(report.finishedAt), report.session, iso(ctx.now), ignored],
  );
  for (const r of results) {
    await ctx.tx.query(
      `INSERT INTO cycle_results (gateway_id, cycle_id, sensor_id, outcome, batch_id, finished_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        g.id, report.cycleId, r.sensorId, storedOutcome(report, r.outcome),
        report.session === 'auth_failed' ? null : r.batchId, iso(report.finishedAt), iso(ctx.now),
      ],
    );
  }
  markDirty(ctx, results.map((r) => r.sensorId));
  return { duplicate: false, ignored };
}

/** The sensors, among `sensorIds`, that this gateway currently covers. */
async function coveredSensorIds(ctx: Ctx, gatewayId: string, sensorIds: string[]): Promise<Set<string>> {
  const { rows } = await ctx.tx.query(
    'SELECT sensor_id FROM sensor_gateways WHERE gateway_id = $1 AND sensor_id = ANY($2)',
    [gatewayId, sensorIds],
  );
  return new Set(rows.map((r) => r.sensor_id as string));
}
