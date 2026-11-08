"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFetch } from "@/lib/useFetch";
import { COLLECTIONS, LIFECYCLES, SENSOR_COVERAGES, type ListResponse, type Sensor } from "@/lib/types";
import { FilterSelect } from "./FilterSelect";
import { Empty, ErrorNote, LINK, Loading, PageHeader, TD, TH } from "./PageParts";
import { SensorActions } from "./SensorActions";
import { StatusBadge } from "./StatusBadge";
import { Held, NextEvaluation, NotApplicable, SensorCounter } from "./TimeCells";
import { humanize } from "@/lib/format";

export interface SensorFilters {
  lifecycle: string;
  coverage: string;
  collection: string;
}

export function SensorReason({ sensor }: { sensor: Sensor }) {
  const r = sensor.lifecycle_reason;
  if (!r) return <NotApplicable hint="No reason: only retired and decommissioned sensors have one." />;
  return <span>{sensor.lifecycle === "retired" ? humanize(r) : r}</span>;
}

export function GatewayLinks({ ids }: { ids: string[] }) {
  if (ids.length === 0) return <span className="text-sm text-slate-700">None assigned</span>;
  return (
    <ul className="flex flex-wrap gap-x-2">
      {ids.map((id) => (
        <li key={id}>
          <Link href={`/gateways/${encodeURIComponent(id)}`} className={`${LINK} font-mono text-xs`}>
            {id}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SensorsView({ filters }: { filters: SensorFilters }) {
  const router = useRouter();
  const q = new URLSearchParams();
  (Object.keys(filters) as (keyof SensorFilters)[]).forEach((k) => filters[k] && q.set(k, filters[k]));
  const qs = q.toString();
  const { data, error, loading, refresh } = useFetch<ListResponse<Sensor>>(qs ? `/api/v1/sensors?${qs}` : "/api/v1/sensors");

  const set = (key: keyof SensorFilters, value: string) => {
    const next = new URLSearchParams(q);
    if (value) next.set(key, value);
    else next.delete(key);
    const s = next.toString();
    router.push(s ? `/sensors?${s}` : "/sensors");
  };
  const filtered = qs !== "";

  return (
    <>
      <PageHeader title="Sensors" subtitle="Lifecycle, collection and coverage are separate facts. Read them side by side." now={data?.server_now} />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <FilterSelect label="Lifecycle" value={filters.lifecycle} options={LIFECYCLES} onChange={(v) => set("lifecycle", v)} />
        <FilterSelect label="Coverage" value={filters.coverage} options={SENSOR_COVERAGES} onChange={(v) => set("coverage", v)} />
        <FilterSelect label="Collection" value={filters.collection} options={COLLECTIONS} onChange={(v) => set("collection", v)} />
        {filtered ? (
          <Link href="/sensors" className={`${LINK} pb-2 text-sm`}>
            Clear filters
          </Link>
        ) : null}
      </div>

      {error ? <ErrorNote error={error} hasData={!!data} /> : null}
      {loading ? <Loading what="sensors" /> : null}
      {data && data.items.length === 0 ? (
        filtered ? (
          <Empty title="No sensors match these filters.">Clear the filters to see every sensor.</Empty>
        ) : (
          <Empty title="No sensors registered yet.">Register one with POST /api/v1/sensors.</Empty>
        )
      ) : null}
      {data && data.items.length > 0 ? (
        <>
          <p className="mb-2 text-sm text-slate-700" aria-live="polite">
            Showing {data.items.length} {data.items.length === 1 ? "sensor" : "sensors"}.
          </p>
          <div tabIndex={0} role="region" aria-label="Sensors table, scrolls sideways on narrow screens" className="overflow-x-auto rounded border border-slate-300 bg-white">
            <table className="w-full min-w-[1200px] border-collapse">
              <caption className="sr-only">Sensors with lifecycle, reason, collection, coverage, next evaluation, counters and gateways</caption>
              <thead className="border-b border-slate-300 bg-slate-100">
                <tr>
                  <th scope="col" className={TH}>Sensor</th>
                  <th scope="col" className={TH}>Lifecycle</th>
                  <th scope="col" className={TH}>Lifecycle reason</th>
                  <th scope="col" className={TH}>Collection</th>
                  <th scope="col" className={TH}>Coverage</th>
                  <th scope="col" className={TH}>Next evaluation</th>
                  <th scope="col" className={`${TH} text-right`}>Quiet checked days</th>
                  <th scope="col" className={`${TH} text-right`}>Sampling cycles done</th>
                  <th scope="col" className={TH}>Gateways</th>
                  <th scope="col" className={TH}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.items.map((s) => (
                  <tr key={s.sensor_id}>
                    <th scope="row" className={`${TD} text-left font-normal`}>
                      <Link href={`/sensors/${encodeURIComponent(s.sensor_id)}`} className={`${LINK} font-mono font-semibold`}>
                        {s.sensor_id}
                      </Link>
                      <div className="text-xs text-slate-600">{s.type}</div>
                    </th>
                    <td className={TD}>
                      <div className="flex items-center gap-1.5 whitespace-nowrap">
                        <StatusBadge kind="lifecycle" value={s.lifecycle} />
                        <Held since={s.lifecycle_since} now={data.server_now} />
                      </div>
                    </td>
                    <td className={TD}>
                      <SensorReason sensor={s} />
                    </td>
                    <td className={TD}>
                      <StatusBadge kind="collection" value={s.collection} />
                    </td>
                    <td className={TD}>
                      <StatusBadge kind="sensorCoverage" value={s.coverage} />
                    </td>
                    <td className={TD}>
                      <NextEvaluation sensor={s} now={data.server_now} />
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>
                      <SensorCounter sensor={s} counter="quiet_checked_days" />
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>
                      <SensorCounter sensor={s} counter="sampling_cycles_done" />
                    </td>
                    <td className={TD}>
                      <GatewayLinks ids={s.gateway_ids} />
                    </td>
                    <td className={TD}>
                      <SensorActions sensor={s} onDone={refresh} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
