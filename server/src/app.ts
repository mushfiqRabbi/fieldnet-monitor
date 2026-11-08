import express, { NextFunction, Request, Response } from 'express';
import { TEST_MODE } from './clock';
import { pool } from './db';
import { errorHandler } from './errors';
import { consoleApi } from './routes/consoleApi';
import { gatewayApi } from './routes/gatewayApi';
import { operatorApi } from './routes/operatorApi';
import { testApi } from './routes/testApi';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  // Liveness for compose and the simulator, in any mode: the API answers and reaches the DB.
  app.get('/healthz', (_req: Request, res: Response, next: NextFunction) => {
    pool.query('SELECT 1').then(() => res.json({ ok: true }), next);
  });
  app.use('/gw/v1', gatewayApi);
  app.use('/api/v1', operatorApi, consoleApi);
  if (TEST_MODE) app.use('/test', testApi);
  app.use((_req: Request, res: Response, _next: NextFunction) => {
    res.status(404).json({ error: 'not_found', detail: 'no such endpoint' });
  });
  app.use(errorHandler);
  return app;
}
