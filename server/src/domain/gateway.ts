import { conflict, invalid } from '../errors';
import { iso } from '../time';
import { issueCommand } from './commands';
import type { Ctx } from './context';
import { changeGatewayState, logInitialGatewayState, sensorIdsOfGateway } from './coverage';
import { sha256 } from './crypto';
import { Gateway, saveGateway } from './gatewayStore';

// Brief, "Gateway transitions". Status moves forward only: late evidence never
// rewrites the past.

/** Create a gateway: status new, command state running, class recoverable. */
export async function createGateway(ctx: Ctx, id: string, name: string, token: string): Promise<boolean> {
  const t = iso(ctx.now);
  const { rowCount } = await ctx.tx.query(
    `INSERT INTO gateways (id, name, token_hash, status, status_since, command_state,
                           command_state_since, coverage_class, created_at)
     VALUES ($1, $2, $3, 'new', $4, 'running', $4, 'recoverable', $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, name, sha256(token), t],
  );
  if (rowCount === 0) return false;
  await logInitialGatewayState(ctx.tx, id);
  return true;
}

export async function recordHeartbeat(ctx: Ctx, g: Gateway, sentAt: number, session: 'ok' | 'auth_failed'): Promise<void> {
  await ctx.tx.query(
    'INSERT INTO heartbeats (gateway_id, sent_at, session, received_at) VALUES ($1, $2, $3, $4)',
    [g.id, iso(sentAt), session, iso(ctx.now)],
  );
  g.lastHeartbeatAt = ctx.now; // heartbeat times are server received times
  if (session === 'auth_failed') await recordAuthFailure(ctx, g, sentAt);
  await saveGateway(ctx.tx, g);
}

/**
 * A heartbeat or cycle with session auth_failed at event time `at`.
 * new / connected / stale -> disconnected; a disconnection keeps its first time.
 * While suspended (or spare) only the auth-failure fields move.
 */
export async function recordAuthFailure(ctx: Ctx, g: Gateway, at: number): Promise<void> {
  g.lastAuthFailureAt = Math.max(g.lastAuthFailureAt ?? at, at);
  const startsDisconnection = g.status === 'new' || g.status === 'connected' || g.status === 'stale';
  if (startsDisconnection) {
    g.disconnectedSince = at;
    g.authFailureStreakStart = at;
    await changeGatewayState(ctx, g, { status: 'disconnected' }, at, { kind: 'transition', rule: 'auth_failed' });
  } else if (g.authFailureStreakStart === null) {
    g.authFailureStreakStart = at;
  }
}

/**
 * Qualifying evidence with event time `at` (cycle finished_at, or a batch's latest
 * accepted taken_at). The caller saves the gateway.
 */
export async function applyQualifyingEvidence(ctx: Ctx, g: Gateway, at: number): Promise<void> {
  if (g.status === 'retired') return;
  // Stale: only evidence from the last 12 hours counts; older late evidence changes nothing.
  if (g.status === 'stale' && at <= ctx.now - ctx.settings.staleAfterMs) return;

  g.lastQualifyingAt = Math.max(g.lastQualifyingAt ?? at, at);
  if (g.authFailureStreakStart !== null && at > g.authFailureStreakStart) g.authFailureStreakStart = null;

  const reconnects =
    g.status === 'new' ||
    g.status === 'stale' ||
    (g.status === 'disconnected' && g.disconnectedSince !== null && at > g.disconnectedSince);
  if (reconnects) {
    g.disconnectedSince = null;
    await changeGatewayState(ctx, g, { status: 'connected' }, at, { kind: 'transition', rule: 'qualifying_evidence' });
  }
  await expireIfStale(ctx, g);
}

/** connected -> stale once 12 hours have passed since last_qualifying_at (effective then). */
export async function expireIfStale(ctx: Ctx, g: Gateway): Promise<void> {
  if (g.status !== 'connected' || g.lastQualifyingAt === null) return;
  const staleAt = g.lastQualifyingAt + ctx.settings.staleAfterMs;
  if (staleAt > ctx.now) return;
  await changeGatewayState(ctx, g, { status: 'stale' }, staleAt, {
    kind: 'transition', rule: 'stale_after_12h', evidenceIds: [],
  });
}

// ---------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------

export type GatewayAction = 'suspend' | 'unsuspend' | 'mark_spare' | 'retire' | 'stop' | 'resume';

const illegal = (detail: string) => conflict('illegal_action', detail);

/** Apply an operator action at the server time. Illegal ones are 409. */
export async function runOperatorAction(ctx: Ctx, g: Gateway, action: GatewayAction, reason?: string): Promise<void> {
  if (g.status === 'retired') throw illegal('gateway is retired');
  const why = (rule: string) => ({ kind: 'action' as const, rule, detail: reason ? { reason } : undefined });
  switch (action) {
    case 'suspend':
      if (!reason) throw invalid('suspend needs a reason');
      if (g.status === 'suspended') throw illegal('gateway is already suspended');
      await changeGatewayState(ctx, g, { status: 'suspended' }, ctx.now, why('suspend'));
      break;
    case 'unsuspend':
      if (g.status !== 'suspended') throw illegal('gateway is not suspended');
      await unsuspend(ctx, g, why('unsuspend'));
      break;
    case 'mark_spare':
      if (g.status !== 'new') throw illegal('only a new gateway can become a spare');
      if ((await sensorIdsOfGateway(ctx.tx, g.id)).length > 0) throw illegal('gateway still covers sensors');
      await changeGatewayState(ctx, g, { status: 'spare' }, ctx.now, why('mark_spare'));
      break;
    case 'retire':
      await changeGatewayState(ctx, g, { status: 'retired' }, ctx.now, why('retire'));
      break;
    case 'stop':
    case 'resume':
      await issueCommand(ctx, g, action, reason);
      break;
  }
  await saveGateway(ctx.tx, g);
}

/**
 * Unsuspend: the status is derived from the evidence.
 * disconnected if the latest auth failure is newer than last_qualifying_at; else
 * new if there was never qualifying evidence; else connected within 12 hours; else stale.
 */
async function unsuspend(ctx: Ctx, g: Gateway, why: { kind: 'action'; rule: string; detail: unknown }): Promise<void> {
  g.disconnectedSince = null;
  const failedAfterEvidence =
    g.lastAuthFailureAt !== null && (g.lastQualifyingAt === null || g.lastAuthFailureAt > g.lastQualifyingAt);
  if (failedAfterEvidence) {
    g.disconnectedSince = g.authFailureStreakStart ?? g.lastAuthFailureAt;
    await changeGatewayState(ctx, g, { status: 'disconnected' }, ctx.now, why);
  } else if (g.lastQualifyingAt === null) {
    await changeGatewayState(ctx, g, { status: 'new' }, ctx.now, why);
  } else if (g.lastQualifyingAt > ctx.now - ctx.settings.staleAfterMs) {
    await changeGatewayState(ctx, g, { status: 'connected' }, ctx.now, why);
  } else {
    await changeGatewayState(ctx, g, { status: 'stale' }, ctx.now, why);
  }
}

/** Assigning a sensor to a spare gateway makes it new again. */
export async function wakeSpare(ctx: Ctx, g: Gateway): Promise<void> {
  if (g.status !== 'spare') return;
  await changeGatewayState(ctx, g, { status: 'new' }, ctx.now, { kind: 'transition', rule: 'sensor_assigned' });
  await saveGateway(ctx.tx, g);
}
