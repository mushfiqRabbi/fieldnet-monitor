import { describe, expect, it } from 'vitest';
import {
  T0, HOUR, addGateway, addSensor, api, cover, cycle, drain, gateway, gatewayAction, heartbeat, iso,
  noReadings, putBatch, reading, sensor, setClock, timeline, useCleanDatabase,
} from './helpers';

useCleanDatabase();

/** A gateway covering s-1, plus its token. */
async function setup() {
  const token = await addGateway();
  await addSensor();
  await cover('s-1', ['gw-1']);
  return token;
}

describe('new -> connected', () => {
  it('a cycle with a readings/no_readings outcome connects at finished_at', async () => {
    const token = await setup();
    await noReadings(token, 'c1', T0 - 60_000).expect(202);
    expect(await gateway()).toMatchObject({
      status: 'connected', status_since: iso(T0 - 60_000), last_qualifying_at: iso(T0 - 60_000), coverage_class: 'available',
    });
  });

  it('a processed batch connects at the latest accepted taken_at', async () => {
    const token = await setup();
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - 120_000), reading('r2', T0 - 30_000)]).expect(202);
    expect((await gateway()).status).toBe('new');
    await drain();
    expect(await gateway()).toMatchObject({ status: 'connected', last_qualifying_at: iso(T0 - 30_000) });
  });

  it('heartbeats alone, could_not_read cycles and ignored results never connect', async () => {
    const token = await setup();
    await heartbeat(token, T0).expect(204);
    await cycle(token, 'c1', T0, [{ sensor_id: 's-1', outcome: 'could_not_read' }, { sensor_id: 's-1', outcome: 'timeout' }]).expect(202);
    const ignoredOnly = await cycle(token, 'c2', T0, [{ sensor_id: 'other', outcome: 'no_readings' }]);
    expect(ignoredOnly.body.ignored).toEqual(['other']);
    expect((await gateway()).status).toBe('new');
  });
});

describe('connected -> stale', () => {
  it('happens exactly 12h after last_qualifying_at, effective then, not at the jump time', async () => {
    const token = await setup();
    await noReadings(token, 'c1', T0).expect(202);
    await setClock(T0 + 12 * HOUR - 1);
    expect((await gateway()).status).toBe('connected');
    await setClock(T0 + 30 * HOUR);
    expect(await gateway()).toMatchObject({ status: 'stale', status_since: iso(T0 + 12 * HOUR), coverage_class: 'recoverable' });
  });

  it('stale -> connected only with evidence from the last 12 hours', async () => {
    const token = await setup();
    await noReadings(token, 'c1', T0).expect(202);
    await setClock(T0 + 30 * HOUR);
    // older, late evidence changes nothing
    await noReadings(token, 'c2', T0 + 10 * HOUR).expect(202);
    expect(await gateway()).toMatchObject({ status: 'stale', last_qualifying_at: iso(T0) });
    // fresh evidence reconnects, effective at its event time
    await noReadings(token, 'c3', T0 + 29 * HOUR).expect(202);
    expect(await gateway()).toMatchObject({ status: 'connected', status_since: iso(T0 + 29 * HOUR), last_qualifying_at: iso(T0 + 29 * HOUR) });
  });
});

describe('auth failures', () => {
  it('a heartbeat with auth_failed disconnects at its event time and keeps the first time', async () => {
    const token = await setup();
    await noReadings(token, 'c1', T0).expect(202);
    await setClock(T0 + HOUR);
    await heartbeat(token, T0 + HOUR - 60_000, 'auth_failed').expect(204);
    expect(await gateway()).toMatchObject({
      status: 'disconnected', status_since: iso(T0 + HOUR - 60_000), disconnected_since: iso(T0 + HOUR - 60_000),
    });
    await setClock(T0 + 2 * HOUR);
    await heartbeat(token, T0 + 2 * HOUR, 'auth_failed').expect(204);
    expect((await gateway()).disconnected_since).toBe(iso(T0 + HOUR - 60_000));
  });

  it('an auth_failed cycle disconnects and records could_not_read', async () => {
    const token = await setup();
    await cycle(token, 'c1', T0, [{ sensor_id: 's-1', outcome: 'no_readings' }], 'auth_failed').expect(202);
    expect(await gateway()).toMatchObject({ status: 'disconnected', disconnected_since: iso(T0), last_qualifying_at: null });
    expect((await sensor()).collection).toBe('not_checked'); // gateway is recoverable, so nothing is read
  });

  it('disconnected -> connected needs qualifying evidence after disconnected_since', async () => {
    const token = await setup();
    await putBatch(token, 'old', 's-1', [reading('r-old', T0 - HOUR)]).expect(202);
    await heartbeat(token, T0, 'auth_failed').expect(204);
    await heartbeat(token, T0 + 60_000, 'ok').expect(204);
    expect((await gateway()).status).toBe('disconnected');
    await drain(); // the old batch is processed after the failure
    expect((await gateway()).status).toBe('disconnected');
    await noReadings(token, 'c1', T0 + 120_000).expect(202);
    expect(await gateway()).toMatchObject({ status: 'connected', status_since: iso(T0 + 120_000), disconnected_since: null });
  });
});

describe('suspend / unsuspend', () => {
  it('suspend needs a reason; automatic rules stop but evidence keeps updating', async () => {
    const token = await setup();
    expect((await gatewayAction('gw-1', 'suspend')).status).toBe(422);
    await noReadings(token, 'c1', T0).expect(202);
    const res = await gatewayAction('gw-1', 'suspend', 'maintenance').expect(200);
    expect(res.body).toMatchObject({ status: 'suspended', coverage_class: 'dead' });
    await setClock(T0 + 20 * HOUR);
    await heartbeat(token, T0 + 20 * HOUR).expect(204);
    await noReadings(token, 'c2', T0 + 19 * HOUR).expect(202);
    expect(await gateway()).toMatchObject({ status: 'suspended', last_qualifying_at: iso(T0 + 19 * HOUR), last_heartbeat_at: iso(T0 + 20 * HOUR) });
    expect((await gatewayAction('gw-1', 'suspend', 'again')).status).toBe(409);
  });

  it('unsuspend derives: connected / stale / new / disconnected', async () => {
    const token = await setup();
    // never qualified -> new
    await gatewayAction('gw-1', 'suspend', 'x').expect(200);
    expect((await gatewayAction('gw-1', 'unsuspend').expect(200)).body.status).toBe('new');
    // qualified within 12h -> connected
    await noReadings(token, 'c1', T0).expect(202);
    await gatewayAction('gw-1', 'suspend', 'x').expect(200);
    await setClock(T0 + 5 * HOUR);
    expect((await gatewayAction('gw-1', 'unsuspend').expect(200)).body.status).toBe('connected');
    // qualified long ago -> stale
    await gatewayAction('gw-1', 'suspend', 'x').expect(200);
    await setClock(T0 + 40 * HOUR);
    expect((await gatewayAction('gw-1', 'unsuspend').expect(200)).body.status).toBe('stale');
    // auth failure newer than last qualifying -> disconnected, since the failure
    await gatewayAction('gw-1', 'suspend', 'x').expect(200);
    await heartbeat(token, T0 + 39 * HOUR, 'auth_failed').expect(204);
    const back = await gatewayAction('gw-1', 'unsuspend').expect(200);
    expect(back.body).toMatchObject({ status: 'disconnected', disconnected_since: iso(T0 + 39 * HOUR) });
    expect((await gatewayAction('gw-1', 'unsuspend')).status).toBe(409);
  });
});

describe('spare and retire', () => {
  it('mark_spare is 409 while the gateway covers sensors, and only from new', async () => {
    const token = await setup();
    expect((await gatewayAction('gw-1', 'mark_spare')).status).toBe(409);
    await addGateway('gw-2');
    expect((await gatewayAction('gw-2', 'mark_spare').expect(200)).body.status).toBe('spare');
    await noReadings(token, 'c1', T0);
    expect((await gatewayAction('gw-1', 'mark_spare')).status).toBe(409);
  });

  it('a sensor assigned to a spare makes it new again', async () => {
    await addGateway('gw-2');
    await addSensor();
    await gatewayAction('gw-2', 'mark_spare').expect(200);
    await cover('s-1', ['gw-2']).expect(200);
    expect(await gateway('gw-2')).toMatchObject({ status: 'new', sensor_ids: ['s-1'] });
  });

  it('a retired gateway: 403 on the gateway API, 409 on coverage and on any action', async () => {
    await setup();
    await addGateway('gw-2');
    await gatewayAction('gw-2', 'retire').expect(200);
    expect((await gateway('gw-2')).status).toBe('retired');
    expect((await cover('s-1', ['gw-1', 'gw-2'])).status).toBe(409);
    expect((await gatewayAction('gw-2', 'unsuspend')).status).toBe(409);
    expect((await gatewayAction('gw-2', 'retire')).status).toBe(409);
  });
});

describe('gateway timeline', () => {
  it('lists entries oldest first with increasing seq and the documented shape', async () => {
    const token = await setup();
    await noReadings(token, 'c1', T0).expect(202);
    await setClock(T0 + 13 * HOUR);
    await gatewayAction('gw-1', 'suspend', 'maintenance').expect(200);
    const entries = await timeline('gateways', 'gw-1');
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
    expect(entries.map((e) => [e.kind, e.axis, e.from, e.to])).toEqual([
      ['transition', 'status', 'new', 'connected'],
      ['transition', 'coverage_class', 'recoverable', 'available'],
      ['transition', 'status', 'connected', 'stale'],
      ['transition', 'coverage_class', 'available', 'recoverable'],
      ['action', 'status', 'stale', 'suspended'],
      ['transition', 'coverage_class', 'recoverable', 'dead'],
    ]);
    expect(entries[0]).toMatchObject({
      effective_at: iso(T0), rule: 'qualifying_evidence', evidence_ids: ['c1'], recorded_at: iso(T0),
    });
    expect(entries[2]).toMatchObject({ effective_at: iso(T0 + 12 * HOUR), recorded_at: iso(T0 + 13 * HOUR) });
    expect(entries[4].detail).toEqual({ reason: 'maintenance' });
    expect(Object.keys(entries[0]).sort()).toEqual(
      ['axis', 'detail', 'effective_at', 'evidence_ids', 'from', 'kind', 'recorded_at', 'rule', 'seq', 'to'],
    );
  });
});
