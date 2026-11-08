import { z } from 'zod';
import { ApiError, invalid } from '../errors';
import { MINUTE, parseIso } from '../time';

/** A device may be at most this far ahead of the server clock (brief: Time and evidence). */
export const MAX_CLOCK_SKEW = 5 * MINUTE;

/** An ISO 8601 timestamp with a zone, kept as the string the device sent. */
export const isoTime = z
  .string()
  .refine((s) => parseIso(s) !== null, { message: 'must be an ISO 8601 timestamp with a zone' });

/** Parse a body with a schema, or fail with 422 validation_error. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ');
  throw invalid(detail);
}

/** Epoch ms of a string already checked with `isoTime`. */
export const toMs = (s: string): number => parseIso(s) as number;

/** 422 invalid_timestamp when a device timestamp is too far after the received time. */
export function assertNotFuture(field: string, t: number, receivedAt: number): void {
  if (t > receivedAt + MAX_CLOCK_SKEW) {
    throw new ApiError(422, 'invalid_timestamp', `${field} is more than 5 minutes in the future`);
  }
}
