import express, { NextFunction, Request, Response } from 'express';
import { TEST_MODE } from './clock';
import { errorHandler } from './errors';
import { consoleApi } from './routes/consoleApi';
import { gatewayApi } from './routes/gatewayApi';
import { operatorApi } from './routes/operatorApi';
import { testApi } from './routes/testApi';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/gw/v1', gatewayApi);
  app.use('/api/v1', operatorApi, consoleApi);
  if (TEST_MODE) app.use('/test', testApi);
  app.use((_req: Request, res: Response, _next: NextFunction) => {
    res.status(404).json({ error: 'not_found', detail: 'no such endpoint' });
  });
  app.use(errorHandler);
  return app;
}
