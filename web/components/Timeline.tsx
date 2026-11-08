import { Badge, StatusBadge, badgeKindFor } from "./StatusBadge";
import { formatAbsolute, formatRelative, humanize } from "@/lib/format";
import type { TimelineEntry } from "@/lib/types";

function Value({ scope, axis, v }: { scope: "gateway" | "sensor"; axis: string | null; v: unknown }) {
  if (v === null || v === undefined) {
    return <span className="text-xs text-slate-600">(none)</span>;
  }
  const kind = badgeKindFor(scope, axis);
  if (kind && typeof v === "string") return <StatusBadge kind={kind} value={v} />;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{text}</code>;
}

function When({ label, iso, now }: { label: string; iso: string | null; now: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-slate-600">{label}</dt>
      <dd className="text-sm">
        {iso ? (
          <>
            <time dateTime={iso} title={formatAbsolute(iso) ?? iso}>
              {formatRelative(iso, now)}
            </time>
            <span className="block text-xs text-slate-600">{formatAbsolute(iso)}</span>
          </>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </dd>
    </div>
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One replaced or recomputed transition inside a correction. Shape is not fixed by the API doc, so be tolerant. */
function TransitionLine({ scope, t }: { scope: "gateway" | "sensor"; t: unknown }) {
  if (isRecord(t) && ("to" in t || "from" in t)) {
    const axis = typeof t.axis === "string" ? t.axis : "lifecycle";
    const eff = typeof t.effective_at === "string" ? t.effective_at : null;
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Value scope={scope} axis={axis} v={t.from} />
        <span aria-label="to">→</span>
        <Value scope={scope} axis={axis} v={t.to} />
        {eff ? <span className="text-xs text-slate-600">at {formatAbsolute(eff) ?? eff}</span> : null}
      </span>
    );
  }
  return <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{JSON.stringify(t)}</code>;
}

function TransitionList({ scope, title, items }: { scope: "gateway" | "sensor"; title: string; items: unknown }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div>
      <p className="text-xs font-semibold text-slate-700">{title}</p>
      {list.length === 0 ? (
        <p className="text-xs text-slate-600">None</p>
      ) : (
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {list.map((t, i) => (
            <li key={i}>
              <TransitionLine scope={scope} t={t} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Detail({ entry, scope }: { entry: TimelineEntry; scope: "gateway" | "sensor" }) {
  const d = entry.detail;
  if (d === null || d === undefined) return null;
  if (entry.kind === "correction" && isRecord(d)) {
    return (
      <div className="mt-2 grid gap-3 rounded border border-amber-500 bg-amber-50 p-3 sm:grid-cols-2">
        <TransitionList scope={scope} title="Replaced (what was recorded before)" items={d.replaced} />
        <TransitionList scope={scope} title="Recomputed (what the evidence now says)" items={d.transitions} />
      </div>
    );
  }
  if (typeof d === "string") {
    return (
      <p className="mt-2 text-sm">
        <span className="font-semibold">Reason:</span> {d}
      </p>
    );
  }
  if (isRecord(d) && typeof d.reason === "string" && Object.keys(d).length === 1) {
    return (
      <p className="mt-2 text-sm">
        <span className="font-semibold">Reason:</span> {d.reason}
      </p>
    );
  }
  return (
    <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-2 text-xs">{JSON.stringify(d, null, 2)}</pre>
  );
}

export function Timeline({
  entries,
  now,
  scope,
}: {
  entries: TimelineEntry[];
  now: string;
  scope: "gateway" | "sensor";
}) {
  if (entries.length === 0) {
    return (
      <p className="rounded border border-dashed border-slate-400 bg-white p-4 text-sm text-slate-700">
        No timeline entries yet. Every change to a state is recorded here.
      </p>
    );
  }
  const ordered = [...entries].sort((a, b) => b.seq - a.seq);
  return (
    <ol aria-label="Timeline, newest first" className="space-y-2">
      {ordered.map((e) => (
        <li key={e.seq} className="rounded border border-slate-300 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-600">#{e.seq}</span>
            {e.kind === "correction" ? (
              <Badge tone="warning">Correction</Badge>
            ) : (
              <span className="rounded border border-slate-400 px-1.5 py-0.5 text-xs font-semibold text-slate-800">
                {humanize(e.kind)}
              </span>
            )}
            {e.axis ? <span className="text-sm font-medium">{humanize(e.axis)}</span> : null}
            {e.from !== undefined || e.to !== undefined ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Value scope={scope} axis={e.axis} v={e.from} />
                <span aria-label="to">→</span>
                <Value scope={scope} axis={e.axis} v={e.to} />
              </span>
            ) : null}
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
            <When label="Effective" iso={e.effective_at} now={now} />
            <When label="Recorded" iso={e.recorded_at} now={now} />
            <div>
              <dt className="text-xs font-semibold text-slate-600">Rule</dt>
              <dd className="text-sm">{e.rule ? <code className="text-xs">{e.rule}</code> : <span className="text-slate-600">—</span>}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-slate-600">Evidence</dt>
              <dd className="text-sm">
                {e.evidence_ids && e.evidence_ids.length > 0 ? (
                  <ul className="flex flex-wrap gap-1">
                    {e.evidence_ids.map((id) => (
                      <li key={id}>
                        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{id}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-slate-600">—</span>
                )}
              </dd>
            </div>
          </dl>
          <Detail entry={e} scope={scope} />
        </li>
      ))}
    </ol>
  );
}
