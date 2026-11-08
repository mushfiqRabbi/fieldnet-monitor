import { iso } from '../time';
import type { CommandState, GatewayCoverageClass, GatewayStatus, TimelineKind } from '../types';
import { Ctx, Db, markDirty } from './context';
import type { Gateway } from './gatewayStore';
import { appendTimeline } from './timeline';

/**
 * Brief, "Coverage": the gateway's class follows from its status and command state.
 * A spare gateway covers nothing, so its class does not matter; we call it recoverable.
 */
export function coverageClassOf(status: GatewayStatus, commandState: CommandState): GatewayCoverageClass {
  if (status === 'suspended' || status === 'retired') return 'dead';
  if (status !== 'connected') return 'recoverable'; // new, spare, stale, disconnected
  const stopProven = commandState === 'stopped' || commandState === 'resume_pending' || commandState === 'resume_failed';
  return stopProven ? 'stopped' : 'available';
}

export async function sensorIdsOfGateway(db: Db, gatewayId: string): Promise<string[]> {
  const { rows } = await db.query('SELECT sensor_id FROM sensor_gateways WHERE gateway_id = $1', [gatewayId]);
  return rows.map((r) => r.sensor_id as string);
}

/** First log row of every gateway: before any evidence it can only be recoverable. */
export async function logInitialGatewayState(db: Db, gatewayId: string): Promise<void> {
  // Effective from the epoch so evidence whose event time is before registration still
  // finds a class. The sensor engine reads this log.
  await db.query(
    `INSERT INTO gateway_state_log (gateway_id, effective_at, status, command_state, coverage_class)
     VALUES ($1, $2, 'new', 'running', 'recoverable')`,
    [gatewayId, iso(0)],
  );
}

async function latestLogTime(db: Db, gatewayId: string): Promise<number> {
  const { rows } = await db.query(
    'SELECT MAX(effective_at) AS t FROM gateway_state_log WHERE gateway_id = $1',
    [gatewayId],
  );
  return rows[0].t === null ? 0 : rows[0].t.getTime();
}

export interface StateChange {
  status?: GatewayStatus;
  commandState?: CommandState;
}

export interface ChangeReason {
  kind: TimelineKind;
  rule: string;
  evidenceIds?: string[];
  detail?: unknown;
}

/**
 * Change a gateway's status and/or command state (in memory; the caller saves it).
 * Appends a timeline entry per axis, a state-log row, and, when the derived coverage
 * class changes, a class entry; the gateway's sensors are then marked for recompute.
 * The effective time is never earlier than the gateway's previous log row, so its
 * history stays ordered even when evidence arrives late.
 */
export async function changeGatewayState(
  ctx: Ctx,
  g: Gateway,
  change: StateChange,
  at: number,
  why: ChangeReason,
): Promise<void> {
  const effectiveAt = Math.max(at, await latestLogTime(ctx.tx, g.id));
  const entry = { entityType: 'gateway' as const, entityId: g.id, effectiveAt, evidenceIds: ctx.evidenceIds, ...why };
  let changed = false;
  if (change.status !== undefined && change.status !== g.status) {
    await appendTimeline(ctx.tx, { ...entry, axis: 'status', from: g.status, to: change.status });
    g.status = change.status;
    g.statusSince = effectiveAt;
    changed = true;
  }
  if (change.commandState !== undefined && change.commandState !== g.commandState) {
    await appendTimeline(ctx.tx, { ...entry, axis: 'command_state', from: g.commandState, to: change.commandState });
    g.commandState = change.commandState;
    g.commandStateSince = effectiveAt;
    changed = true;
  }
  if (changed) await logGatewayState(ctx, g, effectiveAt);
}

async function logGatewayState(ctx: Ctx, g: Gateway, effectiveAt: number): Promise<void> {
  const coverageClass = coverageClassOf(g.status, g.commandState);
  await ctx.tx.query(
    `INSERT INTO gateway_state_log (gateway_id, effective_at, status, command_state, coverage_class)
     VALUES ($1, $2, $3, $4, $5)`,
    [g.id, iso(effectiveAt), g.status, g.commandState, coverageClass],
  );
  if (coverageClass === g.coverageClass) return;
  await appendTimeline(ctx.tx, {
    entityType: 'gateway', entityId: g.id, kind: 'transition', axis: 'coverage_class',
    from: g.coverageClass, to: coverageClass, effectiveAt, rule: 'coverage_derived',
  });
  g.coverageClass = coverageClass;
  markDirty(ctx, await sensorIdsOfGateway(ctx.tx, g.id));
}
