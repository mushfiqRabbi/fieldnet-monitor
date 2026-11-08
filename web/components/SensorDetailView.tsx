"use client";

import { useFetch } from "@/lib/useFetch";
import type { Sensor, Summary, TimelineResponse } from "@/lib/types";
import { Breadcrumb, ErrorNote, Field, Loading, PageHeader } from "./PageParts";
import { SensorActions } from "./SensorActions";
import { GatewayLinks, SensorReason } from "./SensorsView";
import { StatusBadge } from "./StatusBadge";
import { Held, NextEvaluation } from "./TimeCells";
import { Timeline } from "./Timeline";

export function SensorDetailView({ id }: { id: string }) {
  const enc = encodeURIComponent(id);
  const sn = useFetch<Sensor>(`/api/v1/sensors/${enc}`);
  const tl = useFetch<TimelineResponse>(`/api/v1/sensors/${enc}/timeline`);
  const clock = useFetch<Summary>("/api/v1/summary");
  const now = clock.data?.server_now;
  const s = sn.data;

  const refreshAll = () => {
    sn.refresh();
    tl.refresh();
    clock.refresh();
  };

  return (
    <>
      <Breadcrumb href="/sensors" label="Back to sensors" />
      <PageHeader title={`Sensor ${id}`} subtitle={s ? `Type: ${s.type}` : undefined} now={now} />
      {sn.error ? <ErrorNote error={sn.error} hasData={!!s} /> : null}
      {sn.loading ? <Loading what="sensor" /> : null}
      {s && now ? (
        <>
          <div className="mb-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-800">Actions</h2>
            <SensorActions sensor={s} onDone={refreshAll} />
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Lifecycle">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge kind="lifecycle" value={s.lifecycle} />
                <Held since={s.lifecycle_since} now={now} />
              </div>
            </Field>
            <Field label="Lifecycle reason">
              <SensorReason sensor={s} />
            </Field>
            <Field label="Collection">
              <StatusBadge kind="collection" value={s.collection} />
            </Field>
            <Field label="Coverage">
              <StatusBadge kind="sensorCoverage" value={s.coverage} />
            </Field>
            <Field label="Next evaluation">
              <NextEvaluation sensor={s} now={now} />
            </Field>
            <Field label="Quiet checked days">
              <span className="text-base font-semibold tabular-nums">{s.quiet_checked_days}</span>
            </Field>
            <Field label="Sampling cycles done">
              <span className="text-base font-semibold tabular-nums">{s.sampling_cycles_done}</span>
            </Field>
            <Field label={`Gateways (${s.gateway_ids.length})`}>
              <GatewayLinks ids={s.gateway_ids} />
            </Field>
          </dl>
          <h2 className="mb-2 mt-8 text-lg font-semibold">Timeline</h2>
          {tl.error ? <ErrorNote error={tl.error} hasData={!!tl.data} /> : null}
          {tl.loading ? <Loading what="timeline" /> : null}
          {tl.data ? <Timeline entries={tl.data.entries} now={now} scope="sensor" /> : null}
        </>
      ) : null}
    </>
  );
}
