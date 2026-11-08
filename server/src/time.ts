export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 00:00 UTC of the day containing t. */
export function dayStart(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

/** The first 00:00 UTC strictly after t. */
export function nextDayStart(t: number): number {
  return dayStart(t) + DAY;
}

export function iso(t: number | null | undefined): string | null {
  return t === null || t === undefined ? null : new Date(t).toISOString();
}

export function ms(d: Date | string | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  return typeof d === 'string' ? Date.parse(d) : d.getTime();
}

/** Strict ISO 8601 parse. Requires a date, a time and a zone (Z or offset). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export function parseIso(s: unknown): number | null {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
