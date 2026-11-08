import type { NextFunction, Request, Response } from 'express';

/** An error the API turns into {"error": code, "detail": text}. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, detail: string) {
    super(detail);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const invalid = (detail: string) => new ApiError(422, 'validation_error', detail);
export const conflict = (code: string, detail: string) => new ApiError(409, code, detail);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.code, detail: err.message });
    return;
  }
  // express.json() parse errors
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(422).json({ error: 'validation_error', detail: 'body is not valid JSON' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error', detail: 'unexpected server error' });
}
