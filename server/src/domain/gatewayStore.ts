import { notFound } from '../errors';
import { iso } from '../time';
import type { CommandState, GatewayCoverageClass, GatewayStatus } from '../types';
import type { Db } from './context';

export const COLLECTING_AFTER_STOP = 'collecting_after_stop';

/** A gateway as stored. Times are epoch ms. */
export interface Gateway {
  id: string;
  name: string;
  status: GatewayStatus;
  statusSince: number;
  commandState: CommandState;
  commandStateSince: number;
  coverageClass: GatewayCoverageClass;
  lastHeartbeatAt: number | null;
  lastQualifyingAt: number | null;
  disconnectedSince: number | null;
  lastAuthFailureAt: number | null;
  authFailureStreakStart: number | null;
  collectingAfterStop: boolean;
}

const SELECT_GATEWAYS = `
  SELECT id, name, status, status_since, command_state, command_state_since, coverage_class,
         last_heartbeat_at, last_qualifying_at, disconnected_since, last_auth_failure_at,
         auth_failure_streak_start, collecting_after_stop
    FROM gateways`;

const time = (d: Date | null): number | null => (d === null ? null : d.getTime());

function fromRow(r: any): Gateway {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    statusSince: r.status_since.getTime(),
    commandState: r.command_state,
    commandStateSince: r.command_state_since.getTime(),
    coverageClass: r.coverage_class,
    lastHeartbeatAt: time(r.last_heartbeat_at),
    lastQualifyingAt: time(r.last_qualifying_at),
    disconnectedSince: time(r.disconnected_since),
    lastAuthFailureAt: time(r.last_auth_failure_at),
    authFailureStreakStart: time(r.auth_failure_streak_start),
    collectingAfterStop: r.collecting_after_stop,
  };
}

export async function findGateway(db: Db, id: string): Promise<Gateway | null> {
  const { rows } = await db.query(`${SELECT_GATEWAYS} WHERE id = $1`, [id]);
  return rows.length === 0 ? null : fromRow(rows[0]);
}

/** The gateway, or 404. */
export async function requireGateway(db: Db, id: string): Promise<Gateway> {
  const g = await findGateway(db, id);
  if (!g) throw notFound(`gateway ${id}`);
  return g;
}

export async function listGateways(db: Db, status?: string): Promise<Gateway[]> {
  const { rows } =
    status === undefined
      ? await db.query(`${SELECT_GATEWAYS} ORDER BY id`)
      : await db.query(`${SELECT_GATEWAYS} WHERE status = $1 ORDER BY id`, [status]);
  return rows.map(fromRow);
}

/** Write back every field a rule may change. */
export async function saveGateway(db: Db, g: Gateway): Promise<void> {
  await db.query(
    `UPDATE gateways SET
       status = $2, status_since = $3, command_state = $4, command_state_since = $5,
       coverage_class = $6, last_heartbeat_at = $7, last_qualifying_at = $8,
       disconnected_since = $9, last_auth_failure_at = $10, auth_failure_streak_start = $11,
       collecting_after_stop = $12
     WHERE id = $1`,
    [
      g.id, g.status, iso(g.statusSince), g.commandState, iso(g.commandStateSince),
      g.coverageClass, iso(g.lastHeartbeatAt), iso(g.lastQualifyingAt),
      iso(g.disconnectedSince), iso(g.lastAuthFailureAt), iso(g.authFailureStreakStart),
      g.collectingAfterStop,
    ],
  );
}

/** Sensor ids per gateway id, for the gateways that cover any. */
export async function sensorIdsByGateway(db: Db): Promise<Map<string, string[]>> {
  const { rows } = await db.query('SELECT gateway_id, sensor_id FROM sensor_gateways ORDER BY sensor_id');
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.gateway_id, [...(map.get(r.gateway_id) ?? []), r.sensor_id]);
  return map;
}

/** The API shape of a gateway (brief) plus `sensor_ids` (console API). */
export function gatewayJson(g: Gateway, sensorIds: string[]) {
  return {
    gateway_id: g.id,
    name: g.name,
    status: g.status,
    status_since: iso(g.statusSince),
    command_state: g.commandState,
    coverage_class: g.coverageClass,
    last_heartbeat_at: iso(g.lastHeartbeatAt),
    last_qualifying_at: iso(g.lastQualifyingAt),
    // Only meaningful while the gateway is disconnected.
    disconnected_since: g.status === 'disconnected' ? iso(g.disconnectedSince) : null,
    flags: g.collectingAfterStop ? [COLLECTING_AFTER_STOP] : [],
    sensor_ids: sensorIds,
  };
}
