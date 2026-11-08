import { Router } from 'express';
import { z } from 'zod';
import * as clock from '../clock';
import { withWriteTx } from '../db';
import { conflict } from '../errors';
import { runDueWork } from '../domain/work';
import { isoTime, parseBody, toMs } from '../domain/validation';
import { iso } from '../time';
import { asyncHandler } from './http';

// Test endpoints (brief). Mounted only when TEST_MODE=1. In test mode background work
// runs only here, so every test is deterministic.
export const testApi = Router();

const TABLES = [
  'timeline', 'quarantined_readings', 'readings', 'batches', 'commands', 'cycle_results', 'cycles',
  'heartbeats', 'sensor_assignment_log', 'sensor_gateways', 'sensors', 'gateway_state_log', 'gateways',
  'config_versions', 'system_state',
];

testApi.post('/reset', asyncHandler(async (_req, res) => {
  await withWriteTx(async (tx) => {
    await tx.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  });
  clock.resetTestClock();
  res.json({ ok: true });
}));

// The clock moves forward only; the first set after a reset may be any time.
testApi.post('/clock', asyncHandler(async (req, res) => {
  const body = parseBody(z.object({ now: isoTime }), req.body);
  const target = toMs(body.now);
  await withWriteTx(async (tx) => {
    if (clock.isTestClockSet() && target < clock.now()) {
      throw conflict('clock_backwards', `the clock is at ${iso(clock.now())}; it cannot go back`);
    }
    await clock.setTestClock(target, tx);
  });
  await runDueWork(target);
  res.json({ now: iso(target) });
}));

testApi.post('/drain', asyncHandler(async (_req, res) => {
  await runDueWork(clock.now());
  res.json({ now: iso(clock.now()) });
}));

testApi.post('/faults', asyncHandler(async (req, res) => {
  const body = parseBody(z.object({ processing_failures: z.number().int().min(0) }), req.body);
  await withWriteTx(async (tx) => {
    await tx.query(
      `INSERT INTO system_state (key, value) VALUES ('faults', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(body.processing_failures)],
    );
  });
  res.json({ processing_failures: body.processing_failures });
}));
