"use client";

import Link from "next/link";
import { useFetch } from "@/lib/useFetch";
import type { Gateway, Summary, TimelineResponse } from "@/lib/types";
import { GatewayActions } from "./GatewayActions";
import { Breadcrumb, ErrorNote, Field, LINK, Loading, PageHeader } from "./PageParts";
import { FlagBadge, StatusBadge } from "./StatusBadge";
import { Held, NotApplicable, TimeStamp } from "./TimeCells";
import { Timeline } from "./Timeline";

export function GatewayDetailView({ id }: { id: string }) {
  const enc = encodeURIComponent(id);
  const gw = useFetch<Gateway>(`/api/v1/gateways/${enc}`);
  const tl = useFetch<TimelineResponse>(`/api/v1/gateways/${enc}/timeline`);
  // The detail endpoints carry no clock, so take the server clock from the summary.
  const clock = useFetch<Summary>("/api/v1/summary");
  const now = clock.data?.server_now;
  const g = gw.data;

  const refreshAll = () => {
    gw.refresh();
    tl.refresh();
    clock.refresh();
  };

  return (
    <>
      <Breadcrumb href="/gateways" label="Back to gateways" />
      <PageHeader title={g ? g.name : `Gateway ${id}`} subtitle={g ? `Gateway id ${g.gateway_id}` : undefined} now={now} />
      {gw.error ? <ErrorNote error={gw.error} hasData={!!g} /> : null}
      {gw.loading ? <Loading what="gateway" /> : null}
      {g && now ? (
        <>
          <div className="mb-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-800">Actions</h2>
            <GatewayActions gateway={g} onDone={refreshAll} />
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Status">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge kind="gatewayStatus" value={g.status} />
                <Held since={g.status_since} now={now} />
              </div>
            </Field>
            <Field label="Command state">
              <StatusBadge kind="command" value={g.command_state} />
            </Field>
            <Field label="Coverage class">
              <StatusBadge kind="gatewayCoverage" value={g.coverage_class} />
            </Field>
            <Field label="Flags">
              {g.flags.length > 0 ? (
                <div className="flex flex-col items-start gap-1">
                  {g.flags.map((f) => (
                    <FlagBadge key={f} flag={f} />
                  ))}
                </div>
              ) : (
                <NotApplicable hint="No flags raised." />
              )}
            </Field>
            <Field label="Last heartbeat">
              <TimeStamp iso={g.last_heartbeat_at} now={now} neverHint="Never: no heartbeat has been received from this gateway." />
            </Field>
            <Field label="Last qualifying evidence">
              <TimeStamp iso={g.last_qualifying_at} now={now} neverHint="Never: this gateway has not yet shown it is collecting. A heartbeat alone does not count." />
            </Field>
            <Field label="Disconnected since">
              {g.disconnected_since ? (
                <TimeStamp iso={g.disconnected_since} now={now} neverHint="" />
              ) : (
                <NotApplicable hint="Not disconnected." />
              )}
            </Field>
            <Field label={`Sensors covered (${g.sensor_ids.length})`}>
              {g.sensor_ids.length === 0 ? (
                <span>None assigned</span>
              ) : (
                <ul className="flex flex-wrap gap-x-2">
                  {g.sensor_ids.map((s) => (
                    <li key={s}>
                      <Link href={`/sensors/${encodeURIComponent(s)}`} className={`${LINK} font-mono text-xs`}>
                        {s}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </dl>
          <h2 className="mb-2 mt-8 text-lg font-semibold">Timeline</h2>
          {tl.error ? <ErrorNote error={tl.error} hasData={!!tl.data} /> : null}
          {tl.loading ? <Loading what="timeline" /> : null}
          {tl.data ? <Timeline entries={tl.data} now={now} scope="gateway" /> : null}
        </>
      ) : null}
    </>
  );
}
