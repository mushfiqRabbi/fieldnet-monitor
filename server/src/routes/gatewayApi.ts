import { Router } from 'express';
import { z } from 'zod';
import * as clock from '../clock';
import { pool, withWriteTx } from '../db';
import { ApiError } from '../errors';
import { receiveBatch } from '../domain/batches';
import { acknowledgeCommand, commandsForDevice } from '../domain/commands';
import { Ctx, makeCtx } from '../domain/context';
import { bodyHash, sha256 } from '../domain/crypto';
import { ingestCycle } from '../domain/cycles';
import { recordHeartbeat } from '../domain/gateway';
import { Gateway, findGateway, saveGateway } from '../domain/gatewayStore';
import { recomputeDirty } from '../domain/sensorStore';
import { assertNotFuture, isoTime, parseBody, toMs } from '../domain/validation';
import { asyncHandler, param } from './http';

export const gatewayApi = Router();

const unauthorized = () => new ApiError(401, 'unauthorized', 'missing or unknown bearer token');
const retiredError = () => new ApiError(403, 'gateway_retired', 'this gateway is retired');

/** Bearer token -> sha256 -> gateway. Unknown token 401, retired gateway 403. */
gatewayApi.use(
  asyncHandler(async (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!match) throw unauthorized();
    const { rows } = await pool.query('SELECT id, status FROM gateways WHERE token_hash = $1', [sha256(match[1])]);
    if (rows.length === 0) throw unauthorized();
    if (rows[0].status === 'retired') throw retiredError();
    res.locals.gatewayId = rows[0].id;
    next();
  }),
);

/**
 * Run a gateway request as one write: load the gateway, do the work, recompute the
 * sensors it touched. The request's received time is the server clock now.
 */
async function inGatewayTx<T>(
  gatewayId: string,
  receivedAt: number,
  work: (ctx: Ctx, g: Gateway) => Promise<T>,
): Promise<T> {
  return withWriteTx(async (tx) => {
    const g = await findGateway(tx, gatewayId);
    if (!g || g.status === 'retired') throw retiredError();
    const ctx = await makeCtx(tx, receivedAt);
    const result = await work(ctx, g);
    await recomputeDirty(ctx);
    return result;
  });
}

const heartbeatSchema = z.object({ sent_at: isoTime, session: z.enum(['ok', 'auth_failed']) });

gatewayApi.post('/heartbeat', asyncHandler(async (req, res) => {
  const body = parseBody(heartbeatSchema, req.body);
  const receivedAt = clock.now();
  assertNotFuture('sent_at', toMs(body.sent_at), receivedAt);
  await inGatewayTx(res.locals.gatewayId, receivedAt, (ctx, g) =>
    recordHeartbeat(ctx, g, toMs(body.sent_at), body.session));
  res.status(204).end();
}));

// batch_id is required for a readings outcome and must be absent otherwise.
const resultSchema = z
  .object({
    sensor_id: z.string().min(1),
    outcome: z.enum(['readings', 'no_readings', 'could_not_read', 'timeout']),
    batch_id: z.string().min(1).nullish(),
  })
  .superRefine((r, issue) => {
    const hasBatch = r.batch_id !== undefined && r.batch_id !== null;
    if (r.outcome === 'readings' && !hasBatch) {
      issue.addIssue({ code: 'custom', path: ['batch_id'], message: 'required when outcome is readings' });
    }
    if (r.outcome !== 'readings' && hasBatch) {
      issue.addIssue({ code: 'custom', path: ['batch_id'], message: 'must be absent unless outcome is readings' });
    }
  });

const cycleSchema = z.object({
  cycle_id: z.string().min(1),
  started_at: isoTime,
  finished_at: isoTime,
  session: z.enum(['ok', 'auth_failed']),
  results: z.array(resultSchema),
});

gatewayApi.post('/cycles', asyncHandler(async (req, res) => {
  const body = parseBody(cycleSchema, req.body);
  const receivedAt = clock.now();
  assertNotFuture('started_at', toMs(body.started_at), receivedAt);
  assertNotFuture('finished_at', toMs(body.finished_at), receivedAt);
  const report = {
    cycleId: body.cycle_id,
    startedAt: toMs(body.started_at),
    finishedAt: toMs(body.finished_at),
    session: body.session,
    results: body.results.map((r) => ({ sensorId: r.sensor_id, outcome: r.outcome, batchId: r.batch_id ?? null })),
  };
  const { duplicate, ignored } = await inGatewayTx(res.locals.gatewayId, receivedAt, (ctx, g) =>
    ingestCycle(ctx, g, report, bodyHash(body)));
  res.status(duplicate ? 200 : 202).json({ ignored });
}));

// Only the outer shape is checked here; each reading is judged in background processing.
const batchSchema = z.object({
  sensor_id: z.string().min(1),
  readings: z.array(z.record(z.unknown())),
});

gatewayApi.put('/batches/:batchId', asyncHandler(async (req, res) => {
  const body = parseBody(batchSchema, req.body);
  const { created, processing } = await receiveBatch(
    res.locals.gatewayId, param(req, 'batchId'), body, bodyHash(body), clock.now(),
  );
  res.status(created ? 202 : 200).json({ batch_id: param(req, 'batchId'), processing });
}));

gatewayApi.get('/commands', asyncHandler(async (_req, res) => {
  res.json({ commands: await commandsForDevice(pool, res.locals.gatewayId) });
}));

const ackSchema = z.object({ acked_at: isoTime });

gatewayApi.post('/commands/:commandId/ack', asyncHandler(async (req, res) => {
  const body = parseBody(ackSchema, req.body);
  const receivedAt = clock.now();
  assertNotFuture('acked_at', toMs(body.acked_at), receivedAt);
  await inGatewayTx(res.locals.gatewayId, receivedAt, async (ctx, g) => {
    await acknowledgeCommand(ctx, g, param(req, 'commandId'), toMs(body.acked_at));
    await saveGateway(ctx.tx, g);
  });
  res.status(204).end();
}));
