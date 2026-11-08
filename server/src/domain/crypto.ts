import { createHash, randomBytes } from 'crypto';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A gateway token: 32 random bytes as hex. Only its sha256 is stored. */
export const newToken = (): string => randomBytes(32).toString('hex');

/** JSON with object keys sorted at every level, so equal bodies give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const fields = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Idempotency check: two requests are "the same" when their bodies hash equally. */
export const bodyHash = (body: unknown): string => sha256(canonicalJson(body));
