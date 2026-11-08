import { Badge, NeverBadge } from "./StatusBadge";
import { formatAbsolute, formatRelative, heldFor } from "@/lib/format";
import type { Sensor } from "@/lib/types";

/** Relative time (against the server clock) with the absolute UTC time beneath and in the tooltip. */
export function TimeStamp({
  iso,
  now,
  neverHint,
}: {
  iso: string | null;
  now: string;
  neverHint: string;
}) {
  if (!iso) return <NeverBadge hint={neverHint} />;
  const abs = formatAbsolute(iso) ?? iso;
  return (
    <div>
      <time dateTime={iso} title={abs} className="text-sm font-medium">
        {formatRelative(iso, now) ?? abs}
      </time>
      <div className="text-xs text-slate-600">{abs}</div>
    </div>
  );
}

/** "· 2h" after a status badge: how long the state has been held, from server_now. */
export function Held({ since, now }: { since: string | null; now: string }) {
  const d = heldFor(since, now);
  if (!d) return null;
  const abs = formatAbsolute(since);
  return (
    <span className="text-sm text-slate-700" title={abs ? `Since ${abs}` : undefined}>
      · {d}
    </span>
  );
}

/** A plain dash: "not applicable". Distinct from the hatched "unknown" and "paused" styles. */
export function NotApplicable({ hint }: { hint?: string }) {
  return (
    <span className="text-slate-500" title={hint} aria-label={hint ? `Not applicable. ${hint}` : "Not applicable"}>
      <span aria-hidden="true">—</span>
    </span>
  );
}

/**
 * Next evaluation, three different looks:
 *  - a real time:      relative + absolute
 *  - "Paused":         dormant/sampling with coverage not available (timer exists but is held)
 *  - plain "—":        this lifecycle has no timer at all
 */
export function NextEvaluation({ sensor, now }: { sensor: Sensor; now: string }) {
  if (sensor.next_evaluation_at) {
    return <TimeStamp iso={sensor.next_evaluation_at} now={now} neverHint="" />;
  }
  const timed = sensor.lifecycle === "dormant" || sensor.lifecycle === "sampling";
  if (timed && sensor.coverage !== "available") {
    return (
      <Badge tone="paused" glyph="pause" hint={`Timer paused: coverage is ${sensor.coverage}.`}>
        Paused
      </Badge>
    );
  }
  return <NotApplicable hint={`No timer: a ${sensor.lifecycle} sensor has no wait or window running.`} />;
}
