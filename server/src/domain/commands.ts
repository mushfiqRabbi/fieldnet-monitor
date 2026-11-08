import { randomUUID } from 'crypto';
import { conflict, notFound } from '../errors';
import { iso } from '../time';
import type { CommandState, CommandType } from '../types';
import { changeGatewayState } from './coverage';
import type { Ctx, Db } from './context';
import { COLLECTING_AFTER_STOP, type Gateway } from './gatewayStore';
import { appendTimeline } from './timeline';

// Brief, "Stop and resume". The command with the highest seq is the desired state.

const PENDING_STATE: Record<CommandType, CommandState> = { stop: 'stop_pending', resume: 'resume_pending' };
const DONE_STATE: Record<CommandType, CommandState> = { stop: 'stopped', resume: 'running' };

interface Command {
  id: string;
  seq: number;
  type: CommandType;
  issuedAt: number;
  ackedAt: number | null;
}

const fromRow = (r: any): Command => ({
  id: r.id,
  seq: r.seq,
  type: r.type,
  issuedAt: r.issued_at.getTime(),
  ackedAt: r.acked_at === null ? null : r.acked_at.getTime(),
});

async function latestCommand(db: Db, gatewayId: string): Promise<Command | null> {
  const { rows } = await db.query(
    'SELECT id, seq, type, issued_at, acked_at FROM commands WHERE gateway_id = $1 ORDER BY seq DESC LIMIT 1',
    [gatewayId],
  );
  return rows.length === 0 ? null : fromRow(rows[0]);
}

/** What GET /gw/v1/commands returns: the latest command, only while unacknowledged. */
export async function commandsForDevice(db: Db, gatewayId: string) {
  const latest = await latestCommand(db, gatewayId);
  if (!latest || latest.ackedAt !== null) return [];
  return [{ command_id: latest.id, seq: latest.seq, type: latest.type, issued_at: iso(latest.issuedAt) }];
}

/** Operator stop / resume. Illegal repeats are 409. */
export async function issueCommand(ctx: Ctx, g: Gateway, type: CommandType, reason?: string): Promise<void> {
  const repeatsStop = type === 'stop' && (g.commandState === 'stop_pending' || g.commandState === 'stopped');
  const resumesRunning = type === 'resume' && g.commandState === 'running';
  if (repeatsStop || resumesRunning) {
    throw conflict('illegal_action', `cannot ${type} while command state is ${g.commandState}`);
  }
  const { rows } = await ctx.tx.query(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM commands WHERE gateway_id = $1',
    [g.id],
  );
  await ctx.tx.query(
    'INSERT INTO commands (id, gateway_id, seq, type, issued_at) VALUES ($1, $2, $3, $4, $5)',
    [randomUUID(), g.id, rows[0].seq, type, iso(ctx.now)],
  );
  const to = PENDING_STATE[type];
  const why = { kind: 'action' as const, rule: type, detail: reason ? { reason } : undefined };
  if (to !== g.commandState) {
    await changeGatewayState(ctx, g, { commandState: to }, ctx.now, why);
  } else {
    // resume while resume_pending: a re-issue, the state stays but the action is recorded
    await appendTimeline(ctx.tx, {
      entityType: 'gateway', entityId: g.id, axis: 'command_state', from: to, to,
      effectiveAt: ctx.now, ...why,
    });
  }
}

/** The 10-minute timeout: the pending command failed. Called at issued_at + timeout. */
export async function expireCommand(ctx: Ctx, g: Gateway): Promise<void> {
  const failed = g.commandState === 'stop_pending' ? 'stop_failed' : 'resume_failed';
  await changeGatewayState(ctx, g, { commandState: failed }, ctx.now, { kind: 'transition', rule: 'command_timeout' });
}

/**
 * Device acknowledges a command (idempotent). The latest command moves the state;
 * an older, superseded one is only recorded.
 */
export async function acknowledgeCommand(ctx: Ctx, g: Gateway, commandId: string, ackedAt: number): Promise<void> {
  const { rows } = await ctx.tx.query(
    'SELECT id, seq, type, issued_at, acked_at FROM commands WHERE id::text = $1 AND gateway_id = $2',
    [commandId, g.id],
  );
  if (rows.length === 0) throw notFound(`command ${commandId}`);
  const command = fromRow(rows[0]);
  if (command.ackedAt !== null) return;

  await ctx.tx.query('UPDATE commands SET acked_at = $2, ack_received_at = $3 WHERE id = $1', [
    command.id, iso(ackedAt), iso(ctx.now),
  ]);
  const latest = await latestCommand(ctx.tx, g.id);
  if (latest?.id !== command.id) {
    await appendTimeline(ctx.tx, {
      entityType: 'gateway', entityId: g.id, kind: 'ack', axis: 'command_state',
      from: g.commandState, to: g.commandState, effectiveAt: ackedAt, rule: 'ack_superseded',
      evidenceIds: [command.id], detail: { seq: command.seq, type: command.type },
    });
  } else {
    await ctx.tx.query('UPDATE commands SET ack_applied = true WHERE id = $1', [command.id]);
    await changeGatewayState(ctx, g, { commandState: DONE_STATE[command.type] }, Math.max(ackedAt, command.issuedAt), {
      kind: 'ack', rule: `ack_${command.type}`, evidenceIds: [command.id],
    });
  }
  // A stop period is about what the gateway did, so a superseded ack still opens or closes
  // one; it only never changes the command state.
  if (command.type === 'stop') await flagReadingsAfterStopAck(ctx, g, command.seq);
  else await clearFlagIfPeriodEnded(ctx, g);
}

// ---------------------------------------------------------------------------
// collecting_after_stop
// ---------------------------------------------------------------------------

/**
 * Brief: from the acked_at of a stop to the acked_at of the resume that superseded it (the
 * first acknowledged resume with a higher seq); null while there is none yet. Built from the
 * recorded acked_at values, whether or not the ack changed the command state.
 */
interface StopPeriod {
  stopSeq: number;
  start: number;
  end: number | null;
}

async function stopPeriods(db: Db, gatewayId: string): Promise<StopPeriod[]> {
  const { rows } = await db.query(
    'SELECT seq, type, acked_at FROM commands WHERE gateway_id = $1 AND acked_at IS NOT NULL ORDER BY seq',
    [gatewayId],
  );
  const acked = rows.map((r) => ({ seq: r.seq as number, type: r.type as CommandType, at: r.acked_at.getTime() as number }));
  return acked.flatMap((c, i) => {
    if (c.type !== 'stop') return [];
    const resume = acked.slice(i + 1).find((r) => r.type === 'resume');
    return [{ stopSeq: c.seq, start: c.at, end: resume ? resume.at : null }];
  });
}

const inside = (r: { takenAt: number }, p: StopPeriod) => r.takenAt >= p.start && (p.end === null || r.takenAt <= p.end);

/** The open-ended period, if any (the earliest, when several stops are acknowledged). */
const currentPeriod = (periods: StopPeriod[]) =>
  periods.filter((p) => p.end === null).sort((a, b) => a.start - b.start)[0];

/**
 * Readings taken inside a stop period are kept (the caller already stored them); here
 * we add a flag entry and, if the period is still open, raise the flag on the gateway.
 */
export async function flagReadingsInStopPeriods(
  ctx: Ctx,
  g: Gateway,
  readings: { id: string; takenAt: number }[],
): Promise<void> {
  const periods = await stopPeriods(ctx.tx, g.id);
  const flagged = readings.filter((r) => periods.some((p) => inside(r, p)));
  if (flagged.length === 0) return;
  const openPeriod = currentPeriod(periods);
  const inOpenPeriod = openPeriod !== undefined && flagged.some((r) => inside(r, openPeriod));
  await raiseFlag(ctx, g, flagged.map((r) => r.id), inOpenPeriod);
}

async function readingsIn(db: Db, gatewayId: string, p: StopPeriod): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT reading_id FROM readings
      WHERE gateway_id = $1 AND taken_at >= $2 AND ($3::timestamptz IS NULL OR taken_at <= $3)
      ORDER BY taken_at, reading_id`,
    [gatewayId, iso(p.start), iso(p.end)],
  );
  return rows.map((r) => r.reading_id as string);
}

/** A stop ack can arrive after readings it covers; they raise the flag too. */
async function flagReadingsAfterStopAck(ctx: Ctx, g: Gateway, stopSeq: number): Promise<void> {
  const periods = await stopPeriods(ctx.tx, g.id);
  const period = periods.find((p) => p.stopSeq === stopSeq);
  if (!period) return;
  const ids = await readingsIn(ctx.tx, g.id, period);
  if (ids.length > 0) await raiseFlag(ctx, g, ids, period === currentPeriod(periods));
}

async function raiseFlag(ctx: Ctx, g: Gateway, readingIds: string[], raiseOnGateway: boolean): Promise<void> {
  await appendTimeline(ctx.tx, {
    entityType: 'gateway', entityId: g.id, kind: 'flag', axis: 'flags',
    from: g.collectingAfterStop ? COLLECTING_AFTER_STOP : null, to: COLLECTING_AFTER_STOP,
    effectiveAt: ctx.now, rule: COLLECTING_AFTER_STOP, evidenceIds: readingIds,
  });
  if (raiseOnGateway) g.collectingAfterStop = true;
}

/**
 * A resume ack ends the stop period it supersedes. The flag stays only while the current
 * (open) period has readings inside it.
 */
async function clearFlagIfPeriodEnded(ctx: Ctx, g: Gateway): Promise<void> {
  if (!g.collectingAfterStop) return;
  const open = currentPeriod(await stopPeriods(ctx.tx, g.id));
  if (open && (await readingsIn(ctx.tx, g.id, open)).length > 0) return;
  await appendTimeline(ctx.tx, {
    entityType: 'gateway', entityId: g.id, kind: 'flag', axis: 'flags',
    from: COLLECTING_AFTER_STOP, to: null, effectiveAt: ctx.now, rule: 'resume_acknowledged',
  });
  g.collectingAfterStop = false;
}
