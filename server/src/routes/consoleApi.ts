import { Router } from 'express';
import * as clock from '../clock';
import { pool } from '../db';
import { notFound } from '../errors';
import { batchReport } from '../domain/batches';
import { gatewayJson, listGateways, sensorIdsByGateway } from '../domain/gatewayStore';
import { gatewayIdsOfSensors, listSensors, sensorJson } from '../domain/sensorStore';
import { iso } from '../time';
import { asyncHandler, param } from './http';

// List endpoints for the console (docs/console-api.md). Each carries server_now so the
// UI computes "held for 2h" against the server clock, not the browser's.
export const consoleApi = Router();

const queryText = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

consoleApi.get('/gateways', asyncHandler(async (req, res) => {
  const gateways = await listGateways(pool, queryText(req.query.status));
  const sensorIds = await sensorIdsByGateway(pool);
  res.json({
    server_now: iso(clock.now()),
    items: gateways.map((g) => gatewayJson(g, sensorIds.get(g.id) ?? [])),
  });
}));

consoleApi.get('/sensors', asyncHandler(async (req, res) => {
  const sensors = await listSensors(pool, {
    lifecycle: queryText(req.query.lifecycle),
    coverage: queryText(req.query.coverage),
    collection: queryText(req.query.collection),
  });
  const gatewayIds = await gatewayIdsOfSensors(pool);
  res.json({
    server_now: iso(clock.now()),
    items: sensors.map((s) => sensorJson(s, gatewayIds.get(s.id) ?? [])),
  });
}));

consoleApi.get('/batches/:id', asyncHandler(async (req, res) => {
  const report = await batchReport(param(req, 'id'));
  if (!report) throw notFound(`batch ${param(req, 'id')}`);
  res.json(report);
}));

const GATEWAY_STATUSES = ['new', 'spare', 'connected', 'stale', 'disconnected', 'suspended', 'retired'];
const GATEWAY_CLASSES = ['available', 'stopped', 'recoverable', 'dead'];
const LIFECYCLES = ['pending', 'active', 'dormant', 'sampling', 'retired', 'decommissioned'];
const SENSOR_COVERAGES = ['available', 'stopped', 'recoverable', 'none'];
const COLLECTIONS = ['readings', 'no_readings', 'could_not_read', 'timed_out', 'not_checked', 'collection_stopped'];

/** Count rows per value of `column`; every known value is present, 0 when none. */
async function countBy(table: string, column: string, values: string[]): Promise<Record<string, number>> {
  const { rows } = await pool.query(`SELECT ${column} AS value, COUNT(*) AS n FROM ${table} GROUP BY ${column}`);
  const counts = Object.fromEntries(values.map((v) => [v, 0]));
  for (const r of rows) counts[r.value] = Number(r.n);
  return counts;
}

consoleApi.get('/summary', asyncHandler(async (_req, res) => {
  const flagged = await pool.query('SELECT COUNT(*) AS n FROM gateways WHERE collecting_after_stop');
  res.json({
    server_now: iso(clock.now()),
    gateways: {
      by_status: await countBy('gateways', 'status', GATEWAY_STATUSES),
      by_coverage_class: await countBy('gateways', 'coverage_class', GATEWAY_CLASSES),
      flagged: Number(flagged.rows[0].n),
    },
    sensors: {
      by_lifecycle: await countBy('sensors', 'lifecycle', LIFECYCLES),
      by_coverage: await countBy('sensors', 'coverage', SENSOR_COVERAGES),
      by_collection: await countBy('sensors', 'collection', COLLECTIONS),
    },
  });
}));
