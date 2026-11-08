import { describe, expect, it } from 'vitest';
import {
  T0, HOUR, addGateway, addSensor, api, auth, cover, cycle, gateway, iso, setClock, useCleanDatabase,
} from './helpers';

useCleanDatabase();

describe('gateway authentication', () => {
  it('rejects a missing or unknown token with 401', async () => {
    const none = await api().post('/gw/v1/heartbeat').send({ sent_at: iso(T0), session: 'ok' });
    expect(none.status).toBe(401);
    expect(none.body.error).toBe('unauthorized');
    const unknown = await api().get('/gw/v1/commands').set(auth('nope'));
    expect(unknown.status).toBe(401);
  });

  it('rejects a retired gateway with 403 and changes nothing', async () => {
    const token = await addGateway();
    await api().post('/api/v1/gateways/gw-1/actions').send({ action: 'retire' }).expect(200);
    const res = await api().post('/gw/v1/heartbeat').set(auth(token)).send({ sent_at: iso(T0), session: 'ok' });
    expect(res.status).toBe(403);
    expect((await gateway()).last_heartbeat_at).toBeNull();
    expect((await api().get('/gw/v1/commands').set(auth(token))).status).toBe(403);
  });
});

describe('errors', () => {
  it('uses {error, detail} for 404, 422 and 409', async () => {
    const missing = await api().get('/api/v1/gateways/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', detail: expect.any(String) });
    expect((await api().get('/api/v1/nothing')).body.error).toBe('not_found');

    const bad = await api().post('/api/v1/gateways').send({ gateway_id: 5 });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('validation_error');

    const badJson = await api().post('/api/v1/gateways').set('Content-Type', 'application/json').send('{oops');
    expect(badJson.status).toBe(422);

    await addGateway();
    const dup = await api().post('/api/v1/gateways').send({ gateway_id: 'gw-1', name: 'x' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('duplicate_id');
  });

  it('validates heartbeat, cycle and ack bodies with 422', async () => {
    const token = await addGateway();
    const post = (path: string, body: unknown) => api().post(path).set(auth(token)).send(body as object);
    expect((await post('/gw/v1/heartbeat', { sent_at: 'yesterday', session: 'ok' })).status).toBe(422);
    expect((await post('/gw/v1/heartbeat', { sent_at: iso(T0), session: 'maybe' })).status).toBe(422);
    expect((await post('/gw/v1/cycles', { cycle_id: 'c' })).status).toBe(422);
    expect((await post('/gw/v1/commands/x/ack', {})).status).toBe(422);
  });

  it('rejects device timestamps more than 5 minutes ahead with invalid_timestamp', async () => {
    const token = await addGateway();
    await addSensor();
    const ahead = T0 + 6 * 60_000;
    const hb = await api().post('/gw/v1/heartbeat').set(auth(token)).send({ sent_at: iso(ahead), session: 'ok' });
    expect(hb.status).toBe(422);
    expect(hb.body.error).toBe('invalid_timestamp');
    const cy = await cycle(token, 'c1', ahead, []);
    expect(cy.status).toBe(422);
    expect(cy.body.error).toBe('invalid_timestamp');
    const ok = await api().post('/gw/v1/heartbeat').set(auth(token)).send({ sent_at: iso(T0 + 5 * 60_000), session: 'ok' });
    expect(ok.status).toBe(204);
  });

  it('answers 404 for an unknown id in a path or body', async () => {
    await addSensor();
    expect((await cover('s-1', ['ghost'])).status).toBe(404);
    expect((await cover('ghost', [])).status).toBe(404);
    expect((await api().post('/api/v1/sensors/ghost/actions').send({ action: 'decommission', reason: 'x' })).status).toBe(404);
    expect((await api().post('/api/v1/gateways/ghost/actions').send({ action: 'stop' })).status).toBe(404);
    expect((await api().get('/api/v1/batches/ghost')).status).toBe(404);
    expect((await api().get('/api/v1/sensors/ghost/timeline')).status).toBe(404);
  });
});

describe('registration', () => {
  it('registers a gateway as new/running/recoverable and returns a token', async () => {
    const token = await addGateway();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await gateway()).toMatchObject({
      gateway_id: 'gw-1', name: 'Gateway gw-1', status: 'new', status_since: iso(T0), command_state: 'running',
      coverage_class: 'recoverable', last_heartbeat_at: null, last_qualifying_at: null, disconnected_since: null, flags: [],
    });
  });

  it('registers a sensor as pending with no coverage; rejects bad type and duplicates', async () => {
    await addSensor('s-1', 'rain');
    const s = (await api().get('/api/v1/sensors/s-1')).body;
    expect(s).toMatchObject({
      sensor_id: 's-1', type: 'rain', lifecycle: 'pending', lifecycle_reason: null, lifecycle_since: iso(T0),
      collection: 'not_checked', coverage: 'none', quiet_checked_days: 0, sampling_cycles_done: 0, next_evaluation_at: null,
    });
    expect((await api().post('/api/v1/sensors').send({ sensor_id: 's-2', type: 'humidity' })).status).toBe(422);
    expect((await api().post('/api/v1/sensors').send({ sensor_id: 's-1', type: 'rain' })).status).toBe(409);
  });

  it('records last_heartbeat_at as the received time', async () => {
    const token = await addGateway();
    await api().post('/gw/v1/heartbeat').set(auth(token)).send({ sent_at: iso(T0 - HOUR), session: 'ok' }).expect(204);
    expect((await gateway()).last_heartbeat_at).toBe(iso(T0));
  });
});

describe('test endpoints', () => {
  it('moves the clock forward only; the first set after a reset may be any time', async () => {
    await setClock(T0 + HOUR);
    const back = await api().post('/test/clock').send({ now: iso(T0) });
    expect(back.status).toBe(409);
    expect(back.body.error).toBe('clock_backwards');
    await api().post('/test/clock').send({ now: iso(T0 + HOUR) }).expect(200);
    await api().post('/test/reset').expect(200);
    await api().post('/test/clock').send({ now: iso(T0 - 100 * HOUR) }).expect(200);
  });

  it('reset empties every table', async () => {
    await addGateway();
    await addSensor();
    await api().post('/test/reset').expect(200);
    expect((await api().get('/api/v1/gateways')).body.items).toEqual([]);
    expect((await api().get('/api/v1/sensors')).body.items).toEqual([]);
  });
});

describe('GET /healthz', () => {
  it('answers 200 once the API reaches the database (compose healthcheck, simulator start)', async () => {
    expect((await api().get('/healthz')).body).toEqual({ ok: true });
  });
});
