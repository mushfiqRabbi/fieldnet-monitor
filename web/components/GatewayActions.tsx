"use client";

import { useState } from "react";
import { ActionDialog, type ReasonMode } from "./ActionDialog";
import { post } from "@/lib/api";
import { cx } from "@/lib/cx";
import type { Gateway, GatewayAction } from "@/lib/types";

interface Spec {
  label: string;
  title: (g: Gateway) => string;
  description: string;
  confirm: string;
  reason: ReasonMode;
  danger?: boolean;
}

const SPECS: Record<GatewayAction, Spec> = {
  suspend: {
    label: "Suspend",
    title: (g) => `Suspend ${g.name}?`,
    description:
      "While suspended, its status never changes automatically. Heartbeats and evidence are still recorded. Its sensors stop counting it as coverage.",
    confirm: "Suspend gateway",
    reason: "required",
  },
  unsuspend: {
    label: "Unsuspend",
    title: (g) => `Unsuspend ${g.name}?`,
    description: "Its status is worked out again from the latest evidence.",
    confirm: "Unsuspend gateway",
    reason: "optional",
  },
  mark_spare: {
    label: "Mark spare",
    title: (g) => `Mark ${g.name} as spare?`,
    description: "Spare gateways are held in reserve. This only works while the gateway covers no sensors.",
    confirm: "Mark as spare",
    reason: "optional",
  },
  retire: {
    label: "Retire",
    title: (g) => `Retire ${g.name}?`,
    description:
      "Retiring is permanent. The gateway can never connect again and the server rejects all of its requests. This cannot be undone.",
    confirm: "Retire gateway",
    reason: "optional",
    danger: true,
  },
  stop: {
    label: "Stop",
    title: (g) => `Send a stop command to ${g.name}?`,
    description:
      "The gateway should stop collecting. Until it acknowledges, it still counts as available coverage. No acknowledgement within 10 minutes marks the stop as failed.",
    confirm: "Send stop command",
    reason: "optional",
  },
  resume: {
    label: "Resume",
    title: (g) => `Send a resume command to ${g.name}?`,
    description:
      "The gateway should start collecting again. Until it acknowledges, it still counts as stopped coverage. No acknowledgement within 10 minutes marks the resume as failed.",
    confirm: "Send resume command",
    reason: "optional",
  },
};

/** Which actions make sense right now. The server still enforces the rules (409). */
function allowedActions(g: Gateway): GatewayAction[] {
  if (g.status === "retired") return [];
  const out: GatewayAction[] = [];
  if (g.status === "suspended") out.push("unsuspend");
  else out.push("suspend");
  if (g.status === "new") out.push("mark_spare");
  if (g.command_state === "running" || g.command_state === "resume_pending" || g.command_state === "resume_failed")
    out.push("stop");
  else out.push("resume");
  out.push("retire");
  return out;
}

export function GatewayActions({ gateway, onDone }: { gateway: Gateway; onDone: () => void }) {
  const [active, setActive] = useState<GatewayAction | null>(null);
  const actions = allowedActions(gateway);

  if (actions.length === 0) {
    return <span className="text-sm text-slate-600">No actions: retired is permanent.</span>;
  }

  const shown: GatewayAction = active ?? "suspend";
  const spec = SPECS[shown];
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {actions.map((a) => {
          const blocked = a === "mark_spare" && gateway.sensor_ids.length > 0;
          return (
            <button
              key={a}
              type="button"
              disabled={blocked}
              title={blocked ? "Only gateways that cover no sensors can be marked spare." : undefined}
              onClick={() => setActive(a)}
              aria-label={`${SPECS[a].label} ${gateway.name}`}
              className={cx(
                "rounded border px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50",
                a === "retire"
                  ? "border-red-700 bg-white text-red-800 hover:bg-red-50"
                  : "border-slate-500 bg-white text-slate-900 hover:bg-slate-100",
              )}
            >
              {SPECS[a].label}
            </button>
          );
        })}
      </div>
      <ActionDialog
          open={active !== null}
          onClose={() => setActive(null)}
          title={spec.title(gateway)}
          description={spec.description}
          confirmLabel={spec.confirm}
          danger={spec.danger}
          reason={spec.reason}
          onSubmit={async (reason) => {
            await post(`/api/v1/gateways/${encodeURIComponent(gateway.gateway_id)}/actions`, {
              action: shown,
              ...(reason ? { reason } : {}),
            });
            onDone();
          }}
        />
    </>
  );
}
