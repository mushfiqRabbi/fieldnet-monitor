import { describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import {
  T0, addGateway, addSensor, api, cover, cycle, drain, gateway, iso, putBatch, reading, sensor, setClock,
  useCleanDatabase,
} from './helpers';

useCleanDatabase();

const MIN = 60_000;

async function setup(sensorType = 'temperature') {
  const token = await addGateway();
  await addSensor('s-1', sensorType);
  await cover('s-1', ['gw-1']).expect(200);
  return token;
}

const batch = async (id: string) => (await api().get(`/api/v1/batches/${id}`).expect(200)).body;
const accepted = async () => (await pool.query('SELECT reading_id FROM readings ORDER BY reading_id')).rows.map((r) => r.reading_id);

describe('PUT /gw/v1/batches/{id}', () => {
  it('answers 202, an identical repeat 200, a different body 409 batch_conflict', async () => {
    const token = await setup();
    const readings = [reading('r1', T0 - MIN)];
    expect((await putBatch(token, 'b1', 's-1', readings)).status).toBe(202);
    expect((await putBatch(token, 'b1', 's-1', readings)).status).toBe(200);
    const other = await putBatch(token, 'b1', 's-1', [reading('r1', T0 - 2 * MIN)]);
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('batch_conflict');
  });

  it('treats key order as irrelevant for "identical"', async () => {
    const token = await setup();
    const r = reading('r1', T0 - MIN);
    await putBatch(token, 'b1', 's-1', [r]).expect(202);
    const reordered = { unit: r.unit, value: r.value, taken_at: r.taken_at, reading_id: r.reading_id };
    expect((await putBatch(token, 'b1', 's-1', [reordered])).status).toBe(200);
  });

  it('the same batch id from another gateway is 409', async () => {
    const token = await setup();
    const other = await addGateway('gw-2');
    await putBatch(token, 'b1', 's-1', []).expect(202);
    expect((await putBatch(other, 'b1', 's-1', [])).status).toBe(409);
  });

  it('rejects a malformed outer body with 422', async () => {
    const token = await setup();
    expect((await api().put('/gw/v1/batches/b1').set('Authorization', `Bearer ${token}`).send({ sensor_id: 's-1' })).status).toBe(422);
    expect((await putBatch(token, 'b1', 's-1', ['nope'])).status).toBe(422);
  });

  it('is only processed by /test/drain or /test/clock', async () => {
    const token = await setup();
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - MIN)]).expect(202);
    expect(await batch('b1')).toEqual({ processing: 'received', attempts: 0, accepted_count: 0, quarantined: [] });
    await drain();
    expect(await batch('b1')).toEqual({ processing: 'processed', attempts: 1, accepted_count: 1, quarantined: [] });
    await putBatch(token, 'b2', 's-1', [reading('r2', T0)]).expect(202);
    await setClock(T0 + MIN);
    expect((await batch('b2')).processing).toBe('processed');
  });
});

describe('batch processing', () => {
  it('is partially_processed when some readings are invalid, with a reason for each', async () => {
    const token = await setup();
    await putBatch(token, 'b1', 's-1', [
      reading('ok', T0 - MIN),
      reading('bad-unit', T0 - MIN, 20, 'F'),
      reading('bad-value', T0 - MIN, '20', 'C'),
      reading('future', T0 + 6 * MIN),
      { reading_id: 'no-unit', taken_at: iso(T0), value: 1 },
    ]).expect(202);
    await drain();
    const report = await batch('b1');
    expect(report).toMatchObject({ processing: 'partially_processed', attempts: 1, accepted_count: 1 });
    expect(report.quarantined).toEqual([
      { reading_id: 'bad-unit', reason: 'wrong_unit' },
      { reading_id: 'bad-value', reason: 'invalid_value' },
      { reading_id: 'future', reason: 'future_timestamp' },
      { reading_id: 'no-unit', reason: 'missing_field' },
    ]);
    expect(await accepted()).toEqual(['ok']);
  });

  it.each([
    ['temperature', 'C', 'mm'],
    ['rain', 'mm', 'C'],
    ['wind', 'm/s', 'mm'],
  ])('a %s sensor takes %s and rejects %s', async (type, good, bad) => {
    const token = await setup(type);
    await putBatch(token, 'b1', 's-1', [reading('good', T0 - MIN, 1, good), reading('bad', T0 - MIN, 1, bad)]).expect(202);
    await drain();
    expect(await accepted()).toEqual(['good']);
  });

  it('is quarantined when every reading is invalid', async () => {
    const token = await setup();
    await putBatch(token, 'b1', 's-1', [reading('r1', T0, 'x'), reading('r2', T0, 1, 'F')]).expect(202);
    await drain();
    expect(await batch('b1')).toMatchObject({ processing: 'quarantined', accepted_count: 0 });
    expect((await gateway()).status).toBe('new'); // nothing accepted, nothing qualifies
  });

  it('is quarantined with unknown_sensor when the sensor does not exist (still 202 on receipt)', async () => {
    const token = await setup();
    expect((await putBatch(token, 'b1', 'ghost', [reading('r1', T0 - MIN)])).status).toBe(202);
    await drain();
    expect(await batch('b1')).toMatchObject({
      processing: 'quarantined', quarantined: [{ reading_id: 'r1', reason: 'unknown_sensor' }],
    });
  });

  it('ignores a duplicate reading id with the same content and quarantines a different one', async () => {
    const token = await setup();
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - MIN, 20)]).expect(202);
    await putBatch(token, 'b2', 's-1', [reading('r1', T0 - MIN, 20)]).expect(202);
    await putBatch(token, 'b3', 's-1', [reading('r1', T0 - MIN, 21)]).expect(202);
    await drain();
    expect(await batch('b2')).toEqual({ processing: 'processed', attempts: 1, accepted_count: 0, quarantined: [] });
    expect(await batch('b3')).toMatchObject({
      processing: 'quarantined', quarantined: [{ reading_id: 'r1', reason: 'conflicting_duplicate' }],
    });
    expect(await accepted()).toEqual(['r1']);
  });

  it('first version wins also for the same id twice inside one batch', async () => {
    const token = await setup();
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - MIN, 1), reading('r1', T0 - MIN, 1), reading('r1', T0 - MIN, 2)]).expect(202);
    await drain();
    expect(await batch('b1')).toMatchObject({
      processing: 'partially_processed', accepted_count: 1, quarantined: [{ reading_id: 'r1', reason: 'conflicting_duplicate' }],
    });
  });

  it('accepted readings are qualifying evidence and wake the sensor even without a cycle', async () => {
    const token = await setup();
    await putBatch(token, 'b1', 's-1', [reading('r1', T0)]).expect(202);
    await drain();
    expect(await gateway()).toMatchObject({ status: 'connected', last_qualifying_at: iso(T0) });
    expect(await sensor()).toMatchObject({ lifecycle: 'active', lifecycle_since: iso(T0), collection: 'readings' });
  });

  it('a batch may arrive before the cycle that mentions it', async () => {
    const token = await setup();
    await putBatch(token, 'b1', 's-1', [reading('r1', T0)]).expect(202);
    await drain();
    await cycle(token, 'c1', T0, [{ sensor_id: 's-1', outcome: 'readings', batch_id: 'b1' }]).expect(202);
    expect(await sensor()).toMatchObject({ lifecycle: 'active', collection: 'readings' });
  });
});

describe('processing failures', () => {
  it('retries after 1, 2, 4, 8 minutes, then quarantines with processing_failed after the 5th failure', async () => {
    const token = await setup();
    await api().post('/test/faults').send({ processing_failures: 5 }).expect(200);
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - MIN)]).expect(202);

    await drain();
    expect(await batch('b1')).toMatchObject({ processing: 'retrying', attempts: 1 });
    await setClock(T0 + MIN - 1);
    expect((await batch('b1')).attempts).toBe(1);
    await setClock(T0 + MIN);
    expect(await batch('b1')).toMatchObject({ processing: 'retrying', attempts: 2 });
    await setClock(T0 + 3 * MIN - 1);
    expect((await batch('b1')).attempts).toBe(2);
    await setClock(T0 + 3 * MIN);
    expect((await batch('b1')).attempts).toBe(3);
    await setClock(T0 + 7 * MIN);
    expect(await batch('b1')).toMatchObject({ processing: 'retrying', attempts: 4 });
    await setClock(T0 + 15 * MIN);
    expect(await batch('b1')).toEqual({
      processing: 'quarantined', attempts: 5, accepted_count: 0, quarantined: [{ reading_id: 'r1', reason: 'processing_failed' }],
    });
    expect(await accepted()).toEqual([]);
  });

  it('a retried batch never double counts', async () => {
    const token = await setup();
    await api().post('/test/faults').send({ processing_failures: 2 }).expect(200);
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - 2 * MIN), reading('r2', T0 - MIN)]).expect(202);
    await setClock(T0 + 60 * MIN);
    expect(await batch('b1')).toEqual({ processing: 'processed', attempts: 3, accepted_count: 2, quarantined: [] });
    expect(await accepted()).toEqual(['r1', 'r2']);
    await drain();
    expect((await batch('b1')).accepted_count).toBe(2);
  });

  it('only the next n attempts fail', async () => {
    const token = await setup();
    await api().post('/test/faults').send({ processing_failures: 1 }).expect(200);
    await putBatch(token, 'b1', 's-1', [reading('r1', T0 - MIN)]).expect(202);
    await putBatch(token, 'b2', 's-1', [reading('r2', T0 - MIN)]).expect(202);
    await drain();
    expect((await batch('b1')).processing).toBe('retrying');
    expect((await batch('b2')).processing).toBe('processed');
  });
});

describe('a resolved batch recomputes the sensors whose outcomes point to it', () => {
  // A readings outcome shows readings while its batch is unresolved; a quarantined batch
  // turns it into could_not_read at once, not at the next midnight.
  async function readingsOutcome(batchId: string) {
    const token = await setup();
    await cycle(token, 'c1', T0, [{ sensor_id: 's-1', outcome: 'readings', batch_id: batchId }]).expect(202);
    expect(await sensor()).toMatchObject({ collection: 'readings' });
    return token;
  }

  it('every reading invalid', async () => {
    const token = await readingsOutcome('b1');
    await putBatch(token, 'b1', 's-1', [reading('r1', T0, 'x')]).expect(202);
    await drain();
    expect(await sensor()).toMatchObject({ collection: 'could_not_read', lifecycle: 'pending' });
  });

  it('unknown sensor: the sensor named by the cycle is recomputed', async () => {
    const token = await readingsOutcome('b1');
    await putBatch(token, 'b1', 'ghost', [reading('r1', T0)]).expect(202);
    await drain();
    expect((await batch('b1')).processing).toBe('quarantined');
    expect(await sensor()).toMatchObject({ collection: 'could_not_read' });
  });

  it('processing_failed after the 5th attempt', async () => {
    const token = await readingsOutcome('b1');
    await api().post('/test/faults').send({ processing_failures: 5 }).expect(200);
    await putBatch(token, 'b1', 's-1', [reading('r1', T0)]).expect(202);
    await setClock(T0 + 7 * MIN);
    expect(await sensor()).toMatchObject({ collection: 'readings' }); // retrying: still unresolved
    await setClock(T0 + 20 * MIN);
    expect((await batch('b1')).processing).toBe('quarantined');
    expect(await sensor()).toMatchObject({ collection: 'could_not_read' });
  });
});
