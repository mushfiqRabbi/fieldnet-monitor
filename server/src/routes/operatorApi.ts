import { Router } from 'express';
import { z } from 'zod';
import * as clock from '../clock';
import { pool, withWriteTx } from '../db';
import { conflict } from '../errors';
import { makeCtx } from '../domain/context';
import { newToken } from '../domain/crypto';
import { createGateway, runOperatorAction } from '../domain/gateway';
import { gatewayJson, requireGateway } from '../domain/gatewayStore';
import {
  decommissionSensor, gatewayIdsOfSensor, recomputeDirty, registerSensor, replaceCoverage,
  requireSensor, sensorJson,
} from '../domain/sensorStore';
import { sensorIdsOfGateway } from '../domain/coverage';
import { parseBody } from '../domain/validation';
import { readTimeline } from '../domain/timeline';
import { asyncHandler, param } from './http';

export const operatorApi = Router();

const gatewayOf = async (id: string) =>
  gatewayJson(await requireGateway(pool, id), await sensorIdsOfGateway(pool, id));
const sensorOf = async (id: string) =>
  sensorJson(await requireSensor(pool, id), await gatewayIdsOfSensor(pool, id));

// --- gateways ---------------------------------------------------------------

const newGatewaySchema = z.object({ gateway_id: z.string().min(1), name: z.string().min(1) });

operatorApi.post('/gateways', asyncHandler(async (req, res) => {
  const body = parseBody(newGatewaySchema, req.body);
  const token = newToken();
  await withWriteTx(async (tx) => {
    const created = await createGateway(await makeCtx(tx, clock.now()), body.gateway_id, body.name, token);
    if (!created) throw conflict('duplicate_id', `gateway ${body.gateway_id} already exists`);
  });
  res.status(201).json({ token });
}));

operatorApi.get('/gateways/:id', asyncHandler(async (req, res) => {
  res.json(await gatewayOf(param(req, 'id')));
}));

operatorApi.get('/gateways/:id/timeline', asyncHandler(async (req, res) => {
  await requireGateway(pool, param(req, 'id'));
  res.json({ entries: await readTimeline(pool, 'gateway', param(req, 'id')) });
}));

const gatewayActionSchema = z.object({
  action: z.enum(['suspend', 'unsuspend', 'mark_spare', 'retire', 'stop', 'resume']),
  reason: z.string().min(1).nullish(),
}).refine((b) => b.action !== 'suspend' || !!b.reason, { message: 'suspend needs a reason', path: ['reason'] });

operatorApi.post('/gateways/:id/actions', asyncHandler(async (req, res) => {
  const body = parseBody(gatewayActionSchema, req.body);
  await withWriteTx(async (tx) => {
    const ctx = await makeCtx(tx, clock.now());
    const g = await requireGateway(tx, param(req, 'id'));
    await runOperatorAction(ctx, g, body.action, body.reason ?? undefined);
    await recomputeDirty(ctx);
  });
  res.json(await gatewayOf(param(req, 'id')));
}));

// --- sensors ----------------------------------------------------------------

const newSensorSchema = z.object({
  sensor_id: z.string().min(1),
  type: z.enum(['temperature', 'rain', 'wind']),
});

operatorApi.post('/sensors', asyncHandler(async (req, res) => {
  const body = parseBody(newSensorSchema, req.body);
  await withWriteTx(async (tx) => {
    const created = await registerSensor(await makeCtx(tx, clock.now()), body.sensor_id, body.type);
    if (!created) throw conflict('duplicate_id', `sensor ${body.sensor_id} already exists`);
  });
  res.status(201).json(await sensorOf(body.sensor_id));
}));

operatorApi.get('/sensors/:id', asyncHandler(async (req, res) => {
  res.json(await sensorOf(param(req, 'id')));
}));

operatorApi.get('/sensors/:id/timeline', asyncHandler(async (req, res) => {
  await requireSensor(pool, param(req, 'id'));
  res.json({ entries: await readTimeline(pool, 'sensor', param(req, 'id')) });
}));

const coverageSchema = z.object({ gateway_ids: z.array(z.string().min(1)) });

operatorApi.put('/sensors/:id/coverage', asyncHandler(async (req, res) => {
  const body = parseBody(coverageSchema, req.body);
  await withWriteTx(async (tx) => {
    const ctx = await makeCtx(tx, clock.now());
    await replaceCoverage(ctx, param(req, 'id'), body.gateway_ids);
    await recomputeDirty(ctx);
  });
  res.json(await sensorOf(param(req, 'id')));
}));

const sensorActionSchema = z.object({ action: z.literal('decommission'), reason: z.string().min(1) });

operatorApi.post('/sensors/:id/actions', asyncHandler(async (req, res) => {
  const body = parseBody(sensorActionSchema, req.body);
  await withWriteTx(async (tx) => {
    const ctx = await makeCtx(tx, clock.now());
    await decommissionSensor(ctx, param(req, 'id'), body.reason);
    await recomputeDirty(ctx);
  });
  res.json(await sensorOf(param(req, 'id')));
}));
