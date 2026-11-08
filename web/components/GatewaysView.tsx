"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFetch } from "@/lib/useFetch";
import { GATEWAY_STATUSES, type Gateway, type ListResponse } from "@/lib/types";
import { FilterSelect } from "./FilterSelect";
import { GatewayActions } from "./GatewayActions";
import { Empty, ErrorNote, LINK, Loading, PageHeader, TD, TH } from "./PageParts";
import { FlagBadge, StatusBadge } from "./StatusBadge";
import { Held, NotApplicable, TimeStamp } from "./TimeCells";

export function GatewaysView({ status, flagged }: { status: string; flagged: boolean }) {
  const router = useRouter();
  const path = status ? `/api/v1/gateways?status=${encodeURIComponent(status)}` : "/api/v1/gateways";
  const { data, error, loading, refresh } = useFetch<ListResponse<Gateway>>(path);

  const go = (s: string, f: boolean) => {
    const q = new URLSearchParams();
    if (s) q.set("status", s);
    if (f) q.set("flagged", "1");
    const qs = q.toString();
    router.push(qs ? `/gateways?${qs}` : "/gateways");
  };

  const items = data ? data.items.filter((g) => !flagged || g.flags.length > 0) : [];
  const filtered = status !== "" || flagged;

  return (
    <>
      <PageHeader title="Gateways" subtitle="Status, how long it has held it, and the evidence behind it." now={data?.server_now} />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <FilterSelect label="Status" value={status} options={GATEWAY_STATUSES} onChange={(v) => go(v, flagged)} />
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={flagged} onChange={(e) => go(status, e.target.checked)} className="h-4 w-4" />
          Only flagged
        </label>
        {filtered ? (
          <Link href="/gateways" className={`${LINK} pb-2 text-sm`}>
            Clear filters
          </Link>
        ) : null}
      </div>

      {error ? <ErrorNote error={error} hasData={!!data} /> : null}
      {loading ? <Loading what="gateways" /> : null}
      {data && items.length === 0 ? (
        filtered ? (
          <Empty title="No gateways match these filters.">Clear the filters to see every gateway.</Empty>
        ) : (
          <Empty title="No gateways registered yet.">Register one with POST /api/v1/gateways.</Empty>
        )
      ) : null}
      {data && items.length > 0 ? (
        <>
          <p className="mb-2 text-sm text-slate-700" aria-live="polite">
            Showing {items.length} {items.length === 1 ? "gateway" : "gateways"}.
          </p>
          <div tabIndex={0} role="region" aria-label="Gateways table, scrolls sideways on narrow screens" className="overflow-x-auto rounded border border-slate-300 bg-white">
            <table className="w-full min-w-[1100px] border-collapse">
              <caption className="sr-only">Gateways with status, heartbeat, qualifying evidence, command state, coverage, flags and actions</caption>
              <thead className="border-b border-slate-300 bg-slate-100">
                <tr>
                  <th scope="col" className={TH}>Gateway</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}>Last heartbeat</th>
                  <th scope="col" className={TH}>Last qualifying evidence</th>
                  <th scope="col" className={TH}>Command</th>
                  <th scope="col" className={TH}>Coverage</th>
                  <th scope="col" className={TH}>Flags</th>
                  <th scope="col" className={TH}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {items.map((g) => (
                  <tr key={g.gateway_id}>
                    <th scope="row" className={`${TD} text-left font-normal`}>
                      <Link href={`/gateways/${encodeURIComponent(g.gateway_id)}`} className={`${LINK} font-semibold`}>
                        {g.name}
                      </Link>
                      <div className="font-mono text-xs text-slate-600">{g.gateway_id}</div>
                      <div className="text-xs text-slate-600">{g.sensor_ids.length} {g.sensor_ids.length === 1 ? "sensor" : "sensors"}</div>
                    </th>
                    <td className={TD}>
                      <div className="flex items-center gap-1.5 whitespace-nowrap">
                        <StatusBadge kind="gatewayStatus" value={g.status} />
                        <Held since={g.status_since} now={data.server_now} />
                      </div>
                    </td>
                    <td className={TD}>
                      <TimeStamp iso={g.last_heartbeat_at} now={data.server_now} neverHint="Never: no heartbeat has been received from this gateway." />
                    </td>
                    <td className={TD}>
                      <TimeStamp iso={g.last_qualifying_at} now={data.server_now} neverHint="Never: this gateway has not yet shown it is collecting. A heartbeat alone does not count." />
                    </td>
                    <td className={TD}>
                      <StatusBadge kind="command" value={g.command_state} />
                    </td>
                    <td className={TD}>
                      <StatusBadge kind="gatewayCoverage" value={g.coverage_class} />
                    </td>
                    <td className={TD}>
                      {g.flags.length > 0 ? (
                        <div className="flex flex-col items-start gap-1">
                          {g.flags.map((f) => (
                            <FlagBadge key={f} flag={f} />
                          ))}
                        </div>
                      ) : (
                        <NotApplicable hint="No flags raised." />
                      )}
                    </td>
                    <td className={TD}>
                      <GatewayActions gateway={g} onDone={refresh} />
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
