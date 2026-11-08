import { Glyph, type GlyphName } from "./Glyph";
import { cx } from "@/lib/cx";
import { humanize } from "@/lib/format";

/**
 * One place that decides how every state looks.
 *
 *  positive  solid green      healthy / collecting
 *  negative  solid red        failed, disconnected, retired
 *  warning   solid amber      degraded or waiting on something
 *  inactive  solid slate      known, deliberate, neither good nor bad
 *  unknown   dashed + hatch   "we don't know" (not checked, never, no coverage)
 *  paused    dashed + hatch   a clock or collection is deliberately held
 *
 * unknown and paused are never solid, so they cannot be read as healthy or
 * as a zero. Every badge also carries an icon and its text label.
 */
export type Tone = "positive" | "negative" | "warning" | "inactive" | "unknown" | "paused";

const TONE_CLASS: Record<Tone, string> = {
  positive: "border-green-700 bg-green-700 text-white",
  negative: "border-red-700 bg-red-700 text-white",
  warning: "border-amber-500 bg-amber-400 text-slate-900",
  inactive: "border-slate-600 bg-slate-600 text-white",
  unknown: "hatch-unknown border-dashed border-slate-500 text-slate-800",
  paused: "hatch-paused border-dashed border-sky-700 text-sky-900",
};

const TONE_GLYPH: Record<Tone, GlyphName> = {
  positive: "check",
  negative: "cross",
  warning: "warn",
  inactive: "circle",
  unknown: "question",
  paused: "pause",
};

export function Badge({
  tone,
  glyph,
  hint,
  children,
}: {
  tone: Tone;
  glyph?: GlyphName;
  hint?: string;
  children: React.ReactNode;
}) {
  const explain = hint && (tone === "unknown" || tone === "paused");
  return (
    <span
      title={hint}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded border-2 px-2 py-0.5 text-xs font-semibold leading-4",
        TONE_CLASS[tone],
      )}
    >
      <Glyph name={glyph ?? TONE_GLYPH[tone]} />
      <span>{children}</span>
      {explain ? <span className="sr-only">. {hint}</span> : null}
    </span>
  );
}

interface Def {
  tone: Tone;
  hint: string;
  glyph?: GlyphName;
  label?: string;
}

const GATEWAY_STATUS: Record<string, Def> = {
  new: {
    tone: "unknown",
    hint: "New: no qualifying evidence yet, so we don't know whether this gateway is collecting.",
  },
  spare: { tone: "inactive", hint: "Spare: held in reserve and covering no sensors." },
  connected: { tone: "positive", hint: "Connected: qualifying evidence arrived within the last 12 hours." },
  stale: { tone: "warning", hint: "Stale: no qualifying evidence for 12 hours or more." },
  disconnected: { tone: "negative", hint: "Disconnected: the gateway reported an authentication failure." },
  suspended: {
    tone: "paused",
    hint: "Suspended by an operator. Automatic status changes are off until it is unsuspended.",
  },
  retired: {
    tone: "negative",
    glyph: "ban",
    hint: "Retired: permanent. The server rejects every request from this gateway.",
  },
};

const COMMAND_STATE: Record<string, Def> = {
  running: { tone: "positive", hint: "Running: no stop command is in effect." },
  stop_pending: {
    tone: "warning",
    glyph: "clock",
    hint: "Stop pending: waiting for the gateway to acknowledge. Times out after 10 minutes.",
  },
  stopped: { tone: "paused", hint: "Stopped: the gateway acknowledged the stop and should not be collecting." },
  stop_failed: {
    tone: "negative",
    hint: "Stop failed: no acknowledgement within 10 minutes. We have no proof it stopped.",
  },
  resume_pending: {
    tone: "warning",
    glyph: "clock",
    hint: "Resume pending: waiting for the gateway to acknowledge. Times out after 10 minutes.",
  },
  resume_failed: {
    tone: "negative",
    hint: "Resume failed: no acknowledgement within 10 minutes. We have no proof it resumed.",
  },
};

const GATEWAY_COVERAGE: Record<string, Def> = {
  available: { tone: "positive", hint: "Available: this gateway's checks count as evidence for its sensors." },
  stopped: { tone: "paused", hint: "Stopped: the gateway is connected but stopped, so its checks do not count." },
  recoverable: {
    tone: "unknown",
    hint: "Recoverable: new, stale or disconnected. It may come back, so we don't know yet.",
  },
  dead: { tone: "negative", glyph: "ban", hint: "Dead: suspended or retired. It contributes nothing." },
};

const SENSOR_COVERAGE: Record<string, Def> = {
  available: { tone: "positive", hint: "Available: at least one available gateway covers this sensor." },
  stopped: { tone: "paused", hint: "Stopped: the best covering gateway is stopped. Timers are paused." },
  recoverable: {
    tone: "unknown",
    hint: "Recoverable: covering gateways are new, stale or disconnected. We don't know until one reports. Timers are paused.",
  },
  none: {
    tone: "unknown",
    glyph: "dash",
    hint: "None: every covering gateway is dead, or none is assigned. Timers are paused.",
  },
};

const LIFECYCLE: Record<string, Def> = {
  pending: { tone: "unknown", hint: "Pending: no reading has been seen yet, so we don't know if this sensor is alive." },
  active: { tone: "positive", hint: "Active: a reading arrived recently." },
  dormant: { tone: "inactive", glyph: "clock", hint: "Dormant: waiting out 14 days of available time before sampling." },
  sampling: { tone: "warning", glyph: "clock", hint: "Sampling: a 72-hour window is checking whether the sensor is still alive." },
  retired: { tone: "negative", glyph: "ban", hint: "Retired: no readings, or no live coverage. See the reason column." },
  decommissioned: { tone: "inactive", glyph: "ban", hint: "Decommissioned by an operator. Terminal." },
};

const COLLECTION: Record<string, Def> = {
  readings: { tone: "positive", hint: "Readings: an available gateway reported readings in the last 24 hours." },
  no_readings: {
    tone: "inactive",
    hint: "No readings: an available gateway checked and found nothing in the last 24 hours.",
  },
  could_not_read: { tone: "negative", hint: "Could not read: the gateway tried and failed to read this sensor." },
  timed_out: { tone: "warning", glyph: "clock", hint: "Timed out: the gateway's read of this sensor timed out." },
  not_checked: {
    tone: "unknown",
    hint: "Not checked: no available gateway reported on this sensor in the last 24 hours.",
  },
  collection_stopped: {
    tone: "unknown",
    glyph: "pause",
    hint: "Collection stopped: the covering gateway is stopped, so nothing is being checked.",
  },
};

const BATCH: Record<string, Def> = {
  received: { tone: "inactive", hint: "Received, not processed yet." },
  processed: { tone: "positive", hint: "Processed." },
  partially_processed: { tone: "warning", hint: "Partially processed: some readings were quarantined." },
  retrying: { tone: "warning", glyph: "clock", hint: "Processing failed and will be retried." },
  quarantined: { tone: "negative", hint: "Quarantined: nothing was accepted." },
};

const MAPS = {
  gatewayStatus: GATEWAY_STATUS,
  command: COMMAND_STATE,
  gatewayCoverage: GATEWAY_COVERAGE,
  sensorCoverage: SENSOR_COVERAGE,
  lifecycle: LIFECYCLE,
  collection: COLLECTION,
  batch: BATCH,
} as const;

export type BadgeKind = keyof typeof MAPS;

export function StatusBadge({ kind, value }: { kind: BadgeKind; value: string }) {
  const def = MAPS[kind][value];
  if (!def) return <Badge tone="inactive">{humanize(value)}</Badge>;
  return (
    <Badge tone={def.tone} glyph={def.glyph} hint={def.hint}>
      {def.label ?? humanize(value)}
    </Badge>
  );
}

/** Which badge kind a timeline axis uses, so from -> to values look like the tables. */
export function badgeKindFor(scope: "gateway" | "sensor", axis: string | null): BadgeKind | null {
  if (!axis) return null;
  if (scope === "gateway") {
    if (axis === "status") return "gatewayStatus";
    if (axis === "command_state" || axis === "command") return "command";
    if (axis === "coverage_class" || axis === "coverage") return "gatewayCoverage";
  } else {
    if (axis === "lifecycle") return "lifecycle";
    if (axis === "collection") return "collection";
    if (axis === "coverage") return "sensorCoverage";
  }
  return null;
}

export function FlagBadge({ flag }: { flag: string }) {
  if (flag === "collecting_after_stop") {
    return (
      <Badge
        tone="warning"
        hint="Readings were accepted from this gateway while a stop was in effect. They are kept and counted. Clears when a resume is acknowledged."
      >
        Collecting after stop
      </Badge>
    );
  }
  return <Badge tone="warning">{humanize(flag)}</Badge>;
}

/** A missing timestamp means "never", which is not the same as zero or "not applicable". */
export function NeverBadge({ hint }: { hint: string }) {
  return (
    <Badge tone="unknown" glyph="dash" hint={hint}>
      Never
    </Badge>
  );
}
