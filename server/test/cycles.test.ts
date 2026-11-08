import { describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import {
  T0, addGateway, addSensor, api, auth, cover, cycle, gateway, noReadings, sensor, useCleanDatabase,
} from './helpers';

useCleanDatabase();

async function setup() {
  const token = await addGateway();
  await addSensor();
  await cover('s-1', ['gw-1']).expect(200);
  return token;
}

describe('POST /gw/v1/cycles', () => {
  it('answers 202 and lists results for sensors the gateway does not cover as ignored', async () => {
    const token = await setup();
    await addSensor('s-2'); // exists, but not covered by gw-1
    const res = await cycle(token, 'c1', T0, [
      { sensor_id: 's-1', outcome: 'no_readings' },
      { sensor_id: 's-2', outcome: 'no_readings' },
      { sensor_id: 'ghost', outcome: 'could_not_read' },
    ]);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: ['s-2', 'ghost'] });
  });

  it('an identical repeat is 200 and changes nothing; another body with the same id is 409', async () => {
    const token = await setup();
    const results = [{ sensor_id: 's-1', outcome: 'no_readings' }, { sensor_id: 'ghost', outcome: 'no_readings' }];
    await cycle(token, 'c1', T0, results).expect(202);
    const before = await pool.query('SELECT COUNT(*) AS n FROM timeline');
    const repeat = await cycle(token, 'c1', T0, results);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual({ ignored: ['ghost'] });
    expect((await pool.query('SELECT COUNT(*) AS n FROM timeline')).rows).toEqual(before.rows);
    expect((await pool.query('SELECT COUNT(*) AS n FROM cycle_results')).rows[0].n).toBe('1');

    const different = await cycle(token, 'c1', T0, [{ sensor_id: 's-1', outcome: 'could_not_read' }]);
    expect(different.status).toBe(409);
    expect(different.body.error).toBe('cycle_conflict');
  });

  it('keys cycles by gateway: another gateway may reuse a cycle_id', async () => {
    const token = await setup();
    const other = await addGateway('gw-2');
    await cycle(token, 'c1', T0, []).expect(202);
    await cycle(other, 'c1', T0, []).expect(202);
  });

  it('requires batch_id for readings and forbids it for other outcomes (422)', async () => {
    const token = await setup();
    expect((await cycle(token, 'c1', T0, [{ sensor_id: 's-1', outcome: 'readings' }])).status).toBe(422);
    expect((await cycle(token, 'c2', T0, [{ sensor_id: 's-1', outcome: 'no_readings', batch_id: 'b' }])).status).toBe(422);
    expect((await cycle(token, 'c3', T0, [{ sensor_id: 's-1', outcome: 'sometimes' }])).status).toBe(422);
    expect((await cycle(token, 'c4', T0, [{ sensor_id: 's-1', outcome: 'readings', batch_id: 'b' }])).status).toBe(202);
  });

  it('with session auth_failed every outcome is recorded as could_not_read', async () => {
    const token = await setup();
    await cycle(token, 'c1', T0, [{ sensor_id: 's-1', outcome: 'readings', batch_id: 'b1' }], 'auth_failed').expect(202);
    const { rows } = await pool.query('SELECT outcome, batch_id FROM cycle_results');
    expect(rows).toEqual([{ outcome: 'could_not_read', batch_id: null }]);
    expect((await gateway()).status).toBe('disconnected');
  });

  it('stores timeout as timed_out and shows it as the sensor collection', async () => {
    const token = await setup();
    await addSensor('s-2');
    await cover('s-2', ['gw-1']).expect(200);
    await cycle(token, 'c1', T0, [
      { sensor_id: 's-1', outcome: 'timeout' },
      { sensor_id: 's-2', outcome: 'no_readings' }, // makes the gateway connected
    ]).expect(202);
    expect(await sensor('s-1')).toMatchObject({ collection: 'timed_out', coverage: 'available' });
    expect((await sensor('s-2')).collection).toBe('no_readings');
  });

  it('a stale gateway\'s first good cycle counts as a check (gateway first, then sensors)', async () => {
    const token = await setup();
    await noReadings(token, 'c1', T0).expect(202);
    expect((await sensor()).collection).toBe('no_readings');
    await api().post('/test/clock').send({ now: new Date(T0 + 13 * 3_600_000).toISOString() }).expect(200);
    expect(await sensor()).toMatchObject({ coverage: 'recoverable', collection: 'not_checked' });
    await noReadings(token, 'c2', T0 + 12.5 * 3_600_000).expect(202);
    expect(await sensor()).toMatchObject({ coverage: 'available', collection: 'no_readings' });
  });

  it('the Authorization header is required', async () => {
    await setup();
    expect((await api().post('/gw/v1/cycles').send({}).set(auth('x'))).status).toBe(401);
  });
});
