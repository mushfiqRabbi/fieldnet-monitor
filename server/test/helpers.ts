import request from 'supertest';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { migrate } from '../src/migrate';
import { loadClock } from '../src/clock';

export const app = createApp();
export const api = () => request(app);

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
export const iso = (t: number) => new Date(t).toISOString();

/** Create the schema once, and give every test an empty database with the clock at T0. */
export function useCleanDatabase(): void {
  beforeAll(async () => {
    await migrate();
    await loadClock();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await api().post('/test/reset');
    await setClock(T0);
  });
}

export async function setClock(t: number) {
  const res = await api().post('/test/clock').send({ now: iso(t) });
  if (res.status !== 200) throw new Error(`clock failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function drain() {
  await api().post('/test/drain').expect(200);
}

export async function addGateway(id = 'gw-1'): Promise<string> {
  const res = await api().post('/api/v1/gateways').send({ gateway_id: id, name: `Gateway ${id}` }).expect(201);
  return res.body.token;
}

export async function addSensor(id = 's-1', type = 'temperature') {
  await api().post('/api/v1/sensors').send({ sensor_id: id, type }).expect(201);
}

export function cover(sensorId: string, gatewayIds: string[]) {
  return api().put(`/api/v1/sensors/${sensorId}/coverage`).send({ gateway_ids: gatewayIds });
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export function heartbeat(token: string, sentAt: number, session = 'ok') {
  return api().post('/gw/v1/heartbeat').set(auth(token)).send({ sent_at: iso(sentAt), session });
}

export interface CycleResult {
  sensor_id: string;
  outcome: string;
  batch_id?: string;
}

export function cycle(token: string, cycleId: string, finishedAt: number, results: CycleResult[], session = 'ok') {
  return api()
    .post('/gw/v1/cycles')
    .set(auth(token))
    .send({ cycle_id: cycleId, started_at: iso(finishedAt - 60_000), finished_at: iso(finishedAt), session, results });
}

export const noReadings = (cycleToken: string, cycleId: string, at: number, sensor = 's-1') =>
  cycle(cycleToken, cycleId, at, [{ sensor_id: sensor, outcome: 'no_readings' }]);

export interface ReadingInput {
  reading_id: string;
  taken_at: string;
  value: unknown;
  unit: unknown;
}

export const reading = (id: string, takenAt: number, value: unknown = 20, unit: unknown = 'C'): ReadingInput => ({
  reading_id: id, taken_at: iso(takenAt), value, unit,
});

export function putBatch(token: string, batchId: string, sensorId: string, readings: unknown[]) {
  return api().put(`/gw/v1/batches/${batchId}`).set(auth(token)).send({ sensor_id: sensorId, readings });
}

export async function gateway(id = 'gw-1') {
  return (await api().get(`/api/v1/gateways/${id}`).expect(200)).body;
}

export async function sensor(id = 's-1') {
  return (await api().get(`/api/v1/sensors/${id}`).expect(200)).body;
}

export function gatewayAction(id: string, action: string, reason?: string) {
  return api().post(`/api/v1/gateways/${id}/actions`).send({ action, reason });
}

export async function timeline(kind: 'gateways' | 'sensors', id: string) {
  return (await api().get(`/api/v1/${kind}/${id}/timeline`).expect(200)).body.entries as any[];
}
