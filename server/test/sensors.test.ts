import { describe, expect, it } from 'vitest';
import {
  DAY, HOUR, T0, addGateway, addSensor, api, cover, cycle, drain, gatewayAction, iso, noReadings, putBatch,
  reading, sensor, setClock, timeline, useCleanDatabase,
} from './helpers';

useCleanDatabase();

const MIN = 60_000;

describe('sensor coverage', () => {
  it('follows the best class among the covering gateways, and none without any', async () => {
    const token = await addGateway('gw-1');
    await addGateway('gw-2');
    await addSensor();
    expect((await sensor()).coverage).toBe('none');
    await cover('s-1', ['gw-2']).expect(200);
    expect((await sensor()).coverage).toBe('recoverable');
    await noReadings(token, 'c1', T0).expect(202); // gw-1 not assigned: ignored
    await cover('s-1', ['gw-1', 'gw-2']).expect(200);
    await noReadings(token, 'c2', T0).expect(202);
    expect(await sensor()).toMatchObject({ coverage: 'available', gateway_ids: ['gw-1', 'gw-2'] });
    await gatewayAction('gw-1', 'suspend', 'x').expect(200);
    expect((await sensor()).coverage).toBe('recoverable');
    await gatewayAction('gw-2', 'suspend', 'x').expect(200);
    expect((await sensor()).coverage).toBe('none');
    await cover('s-1', []).expect(200);
    expect((await sensor()).coverage).toBe('none');
  });

  it('losing all live coverage retires an active sensor; coming back makes it pending', async () => {
    const token = await addGateway();
    await addSensor();
    await cover('s-1', ['gw-1']).expect(200);
    await putBatch(token, 'b1', 's-1', [reading('r1', T0)]).expect(202);
    await drain();
    expect((await sensor()).lifecycle).toBe('active');

    await setClock(T0 + HOUR);
    await gatewayAction('gw-1', 'suspend', 'x').expect(200);
    expect(await sensor()).toMatchObject({ lifecycle: 'retired', lifecycle_reason: 'no_live_coverage', coverage: 'none' });
    await setClock(T0 + 2 * HOUR);
    await gatewayAction('gw-1', 'unsuspend').expect(200);
    expect(await sensor()).toMatchObject({ lifecycle: 'pending', lifecycle_reason: null, quiet_checked_days: 0 });
  });

  it('answers 409 for a retired gateway id, 404 for an unknown one, and replaces the set', async () => {
    await addGateway('gw-1');
    await addGateway('gw-2');
    await addSensor();
    await cover('s-1', ['gw-1']).expect(200);
    await cover('s-1', ['gw-2']).expect(200);
    expect((await sensor()).gateway_ids).toEqual(['gw-2']);
    await gatewayAction('gw-1', 'retire').expect(200);
    const retired = await cover('s-1', ['gw-1']);
    expect(retired.status).toBe(409);
    expect((await sensor()).gateway_ids).toEqual(['gw-2']);
    expect((await cover('s-1', ['nope'])).status).toBe(404);
    expect((await api().put('/api/v1/sensors/s-1/coverage').send({ gateway_ids: 'gw-1' })).status).toBe(422);
  });
});

describe('evidence dated before the coverage assignment', () => {
  it('a reading taken minutes before the PUT still wakes the sensor (readings are facts)', async () => {
    const token = await addGateway();
    await addSensor();
    await cover('s-1', ['gw-1']).expect(200);
    await cycle(token, 'c1', T0 - 5 * MIN, [{ sensor_id: 's-1', outcome: 'readings', batch_id: 'b1' }]).expect(202);
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - 6 * MIN)]).expect(202);
    await drain();
    expect(await sensor()).toMatchObject({
      lifecycle: 'active', lifecycle_since: iso(T0 - 6 * MIN), coverage: 'available', collection: 'readings',
    });
    const coverage = (await timeline('sensors', 's-1')).find((e) => e.axis === 'coverage');
    expect(coverage).toMatchObject({ from: 'none', effective_at: iso(T0) }); // the PUT keeps server time
  });

  it('a sensor with no assignment stays pending with coverage none', async () => {
    const token = await addGateway();
    await addSensor();
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - MIN)]).expect(202);
    await drain();
    expect(await sensor()).toMatchObject({ lifecycle: 'pending', coverage: 'none' });
  });
});

describe('decommission', () => {
  it('needs a reason, is terminal, and any later action or coverage change is 409', async () => {
    await addGateway();
    await addSensor();
    await cover('s-1', ['gw-1']).expect(200);
    const post = (body: object) => api().post('/api/v1/sensors/s-1/actions').send(body);
    expect((await post({ action: 'decommission' })).status).toBe(422);
    expect((await post({ action: 'explode', reason: 'x' })).status).toBe(422);

    const done = await post({ action: 'decommission', reason: 'site closed' }).expect(200);
    expect(done.body).toMatchObject({ lifecycle: 'decommissioned', lifecycle_reason: 'site closed', next_evaluation_at: null });
    expect((await post({ action: 'decommission', reason: 'again' })).status).toBe(409);
    expect((await cover('s-1', ['gw-1'])).status).toBe(409);
    expect((await cover('s-1', [])).status).toBe(409);

    const last = (await timeline('sensors', 's-1')).at(-1);
    expect(last).toMatchObject({ kind: 'action', axis: 'lifecycle', to: 'decommissioned', detail: { reason: 'site closed' } });
  });

  it('later evidence cannot change a decommissioned sensor', async () => {
    const token = await addGateway();
    await addSensor();
    await cover('s-1', ['gw-1']).expect(200);
    await api().post('/api/v1/sensors/s-1/actions').send({ action: 'decommission', reason: 'gone' }).expect(200);
    await putBatch(token, 'b1', 's-1', [reading('r1', T0)]).expect(202);
    await drain();
    await setClock(T0 + 30 * DAY);
    expect(await sensor()).toMatchObject({ lifecycle: 'decommissioned', lifecycle_reason: 'gone' });
  });
});

describe('sensor timeline and late data', () => {
  it('records transitions oldest first with the documented shape', async () => {
    const token = await addGateway();
    await addSensor();
    await cover('s-1', ['gw-1']).expect(200);
    await putBatch(token, 'b1', 's-1', [reading('r1', T0)]).expect(202);
    await drain();
    const entries = await timeline('sensors', 's-1');
    // a bare JSON array, as the brief lists it (no wrapper object), for both entity kinds
    expect(Array.isArray((await api().get('/api/v1/sensors/s-1/timeline')).body)).toBe(true);
    expect(Array.isArray((await api().get('/api/v1/gateways/gw-1/timeline')).body)).toBe(true);
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
    expect(entries.map((e) => [e.kind, e.axis, e.from, e.to])).toEqual([
      ['transition', 'coverage', 'none', 'recoverable'],
      ['transition', 'lifecycle', 'pending', 'active'],
      ['transition', 'coverage', 'recoverable', 'available'],
      ['transition', 'collection', 'not_checked', 'readings'],
    ]);
    expect(entries[1]).toMatchObject({ rule: 'first_reading', effective_at: iso(T0), evidence_ids: ['r1'] });
  });

  it('a late reading corrects dormant -> active without editing the dormant entry (brief variation)', async () => {
    const token = await addGateway();
    await addSensor();
    await cover('s-1', ['gw-1']).expect(200);
    const day = (n: number, hour = 12) => T0 - 12 * HOUR + n * DAY + hour * HOUR; // T0 is day 0, 12:00

    // day 0: a reading, then a no_readings cycle every 8 hours
    await putBatch(token, 'b0', 's-1', [reading('r0', T0)]).expect(202);
    await cycle(token, 'c0', T0, [{ sensor_id: 's-1', outcome: 'readings', batch_id: 'b0' }]).expect(202);
    for (let t = T0 + 8 * HOUR, n = 1; t <= day(20); t += 8 * HOUR, n++) {
      await setClock(t);
      await noReadings(token, `c${n}`, t).expect(202);
    }
    await setClock(day(20));
    expect(await sensor()).toMatchObject({ lifecycle: 'dormant', lifecycle_since: iso(day(15, 0)), quiet_checked_days: 14 });

    // day 20: a batch with a reading taken on day 9 arrives
    await putBatch(token, 'late', 's-1', [reading('late-r', day(9))]).expect(202);
    await drain();
    expect(await sensor()).toMatchObject({
      lifecycle: 'active', lifecycle_since: iso(T0), quiet_checked_days: 10, next_evaluation_at: null,
    });
    const lifecycle = (await timeline('sensors', 's-1')).filter((e) => e.axis === 'lifecycle');
    expect(lifecycle.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['transition', 'pending', 'active'],
      ['transition', 'active', 'dormant'], // stays: earlier entries are never edited
      ['correction', 'dormant', 'active'],
    ]);
    expect(lifecycle[1].effective_at).toBe(iso(day(15, 0)));
    expect(lifecycle[2].evidence_ids).toEqual(['late-r']);
    expect(lifecycle[2].detail.replaced).toHaveLength(1);
    expect(lifecycle[2].detail.transitions).toEqual([]);

    // a late reading that changes nothing records nothing
    const before = (await timeline('sensors', 's-1')).length;
    await putBatch(token, 'late2', 's-1', [reading('late-r2', day(12))]).expect(202);
    await drain();
    expect((await timeline('sensors', 's-1')).filter((e) => e.kind === 'correction')).toHaveLength(1);
    expect((await timeline('sensors', 's-1')).length).toBe(before);
  });
});
