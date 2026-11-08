"use client";

import Link from "next/link";
import { useFetch } from "@/lib/useFetch";
import { COLLECTIONS, GATEWAY_STATUSES, LIFECYCLES, SENSOR_COVERAGES, type Summary } from "@/lib/types";
import { ErrorNote, Loading, PageHeader } from "./PageParts";
import { FlagBadge, StatusBadge, type BadgeKind } from "./StatusBadge";

function Tile({ href, count, children, label }: { href: string; count: number; children: React.ReactNode; label: string }) {
  return (
    <li>
      <Link
        href={href}
        aria-label={`${label}: ${count}. Show list.`}
        className="flex items-center justify-between gap-3 rounded border border-slate-300 bg-white px-3 py-2 hover:border-slate-500 hover:bg-slate-50"
      >
        {children}
        {/* Counts are plain numbers, including 0. Only the badge carries the state style. */}
        <span className="text-xl font-semibold tabular-nums text-slate-900">{count}</span>
      </Link>
    </li>
  );
}

function Group({
  title,
  kind,
  values,
  counts,
  param,
  base,
}: {
  title: string;
  kind: BadgeKind;
  values: readonly string[];
  counts: Record<string, number>;
  param: string;
  base: string;
}) {
  return (
    <section aria-labelledby={`g-${param}-${base}`}>
      <h3 id={`g-${param}-${base}`} className="mb-2 text-sm font-semibold text-slate-800">
        {title}
      </h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {values.map((v) => (
          <Tile key={v} href={`${base}?${param}=${v}`} count={counts[v] ?? 0} label={`${title} ${v}`}>
            <StatusBadge kind={kind} value={v} />
          </Tile>
        ))}
      </ul>
    </section>
  );
}

export function DashboardView() {
  const { data, error, loading } = useFetch<Summary>("/api/v1/summary");
  return (
    <>
      <PageHeader title="Situation" subtitle="Which gateways are really working, and which sensors are really alive." now={data?.server_now} />
      {error ? <ErrorNote error={error} hasData={!!data} /> : null}
      {loading ? <Loading what="situation counts" /> : null}
      {data ? (
        <div className="space-y-8">
          <section aria-labelledby="gw-h" className="space-y-4">
            <h2 id="gw-h" className="text-lg font-semibold">
              Gateways
            </h2>
            <Group title="By status" kind="gatewayStatus" values={GATEWAY_STATUSES} counts={data.gateways.by_status} param="status" base="/gateways" />
            <section aria-labelledby="flag-h">
              <h3 id="flag-h" className="mb-2 text-sm font-semibold text-slate-800">
                Flagged
              </h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                <Tile href="/gateways?flagged=1" count={data.gateways.flagged} label="Flagged gateways">
                  <FlagBadge flag="collecting_after_stop" />
                </Tile>
              </ul>
            </section>
          </section>
          <section aria-labelledby="s-h" className="space-y-4">
            <h2 id="s-h" className="text-lg font-semibold">
              Sensors
            </h2>
            <Group title="By lifecycle" kind="lifecycle" values={LIFECYCLES} counts={data.sensors.by_lifecycle} param="lifecycle" base="/sensors" />
            <Group title="By coverage" kind="sensorCoverage" values={SENSOR_COVERAGES} counts={data.sensors.by_coverage} param="coverage" base="/sensors" />
            <Group title="By collection" kind="collection" values={COLLECTIONS} counts={data.sensors.by_collection} param="collection" base="/sensors" />
          </section>
        </div>
      ) : null}
    </>
  );
}
