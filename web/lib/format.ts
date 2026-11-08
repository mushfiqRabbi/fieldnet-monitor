// Formatting helpers. Every "how long" is measured against the server clock
// (`server_now`), never the browser clock.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "just now", "5m", "2h", "3d 4h", "3d". Negative values are treated as 0. */
export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MIN) return "just now";
  if (v < HOUR) return `${Math.floor(v / MIN)}m`;
  if (v < DAY) return `${Math.floor(v / HOUR)}h`;
  const days = Math.floor(v / DAY);
  const hours = Math.floor((v % DAY) / HOUR);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/** How long something has been the case: from `sinceIso` to `nowIso`. */
export function heldFor(sinceIso: string | null | undefined, nowIso: string | null | undefined): string | null {
  const since = toMs(sinceIso);
  const now = toMs(nowIso);
  if (since === null || now === null) return null;
  return formatDuration(now - since);
}

/** "2h ago", "in 3d 4h" or "just now". */
export function formatRelative(iso: string | null | undefined, nowIso: string | null | undefined): string | null {
  const t = toMs(iso);
  const now = toMs(nowIso);
  if (t === null || now === null) return null;
  const diff = now - t;
  if (Math.abs(diff) < MIN) return "just now";
  return diff > 0 ? `${formatDuration(diff)} ago` : `in ${formatDuration(-diff)}`;
}

/** "2026-01-01 12:00:00 UTC" */
export function formatAbsolute(iso: string | null | undefined): string | null {
  const t = toMs(iso);
  if (t === null) return null;
  return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
}

/** "could_not_read" -> "Could not read" */
export function humanize(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
